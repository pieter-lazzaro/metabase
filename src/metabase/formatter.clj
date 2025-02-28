(ns metabase.formatter
  "Provides functions that support formatting results data. In particular, customizing formatting for when timezone,
   column metadata, and visualization-settings are known. These functions can be used for uniform rendering of all
   artifacts such as generated CSV or image files that need consistent formatting across the board."
  (:require
   [clojure.pprint :refer [cl-format]]
   [clojure.string :as str]
   [hiccup.util]
   [metabase.formatter.datetime :as datetime]
   [metabase.public-settings :as public-settings]
   [metabase.shared.models.visualization-settings :as mb.viz]
   [metabase.shared.util.currency :as currency]
   [metabase.types :as types]
   [metabase.util.malli :as mu]
   [metabase.util.malli.schema :as ms]
   [metabase.util.ui-logic :as ui-logic]
   [potemkin.types :as p.types])
  (:import
   (java.math RoundingMode)
   (java.net URL)
   (java.text DecimalFormat DecimalFormatSymbols)))

(set! *warn-on-reflection* true)

;; Fool Eastwood into thinking this namespace is used
(comment hiccup.util/keep-me)

(def RenderedPulseCard
  "Schema used for functions that operate on pulse card contents and their attachments"
  [:map
   [:attachments [:maybe [:map-of :string (ms/InstanceOfClass URL)]]]
   [:content     [:sequential :any]]
   [:render/text {:optional true} [:maybe :string]]])

(p.types/defrecord+ NumericWrapper [^String num-str ^Number num-value]
  hiccup.util/ToString
  (to-str [_] num-str)

  Object
  (toString [_] num-str))

(defn- strip-trailing-zeroes
  [num-as-string decimal]
  (if (str/includes? num-as-string (str decimal))
    (let [pattern (re-pattern (str/escape (str decimal \$) {\. "\\."}))]
      (-> num-as-string
          (str/split #"0+$")
          first
          (str/split pattern)
          first))
    num-as-string))

(defn- digits-after-decimal
  ([value] (digits-after-decimal value "."))
  ([value decimal]
   (if (zero? value)
     0
     (let [val-string (-> (condp = (type value)
                            java.math.BigDecimal (.toPlainString ^BigDecimal value)
                            java.lang.Double (format "%.20f" value)
                            java.lang.Float (format "%.20f" value)
                            (str value))
                          (strip-trailing-zeroes (str decimal)))
           [_n d] (str/split val-string #"[^\d*]")]
       (count d)))))

(defn- sig-figs-after-decimal
  [value decimal]
  (if (zero? value)
    0
    (let [val-string (-> (condp = (type value)
                           java.math.BigDecimal (.toPlainString ^BigDecimal value)
                           java.lang.Double (format "%.20f" value)
                           java.lang.Float (format "%.20f" value)
                           (str value))
                         (strip-trailing-zeroes (str decimal)))
          figs (last (str/split val-string #"[\.0]+"))]
      (count figs))))

(defn number-formatter
  "Return a function that will take a number and format it according to its column viz settings. Useful to compute the
  format string once and then apply it over many values."
  [{:keys [semantic_type effective_type base_type]
    col-id :id field-ref :field_ref col-name :name :as _column}
   viz-settings]
  (let [col-id (or col-id (second field-ref))
        column-settings (-> (get viz-settings ::mb.viz/column-settings)
                            (update-keys #(select-keys % [::mb.viz/field-id ::mb.viz/column-name])))
        column-settings (or (get column-settings {::mb.viz/field-id col-id})
                            (get column-settings {::mb.viz/column-name col-name}))
        global-settings (::mb.viz/global-column-settings viz-settings)
        currency?       (boolean (or (= (::mb.viz/number-style column-settings) "currency")
                                     (and (nil? (::mb.viz/number-style column-settings))
                                          (or
                                           (::mb.viz/currency-style column-settings)
                                           (::mb.viz/currency column-settings)))))
        {::mb.viz/keys [number-separators decimals scale number-style
                        prefix suffix currency-style currency]} (merge
                                                                 (when currency?
                                                                   (:type/Currency global-settings))
                                                                 (:type/Number global-settings)
                                                                 column-settings)
        integral?       (isa? (or effective_type base_type) :type/Integer)
        relation?       (isa? semantic_type :Relation/*)
        percent?        (or (isa? semantic_type :type/Percentage) (= number-style "percent"))
        scientific?     (= number-style "scientific")
        [decimal grouping] (or number-separators
                               (get-in (public-settings/custom-formatting) [:type/Number :number_separators])
                               ".,")
        symbols            (doto (DecimalFormatSymbols.)
                             (cond-> decimal (.setDecimalSeparator decimal))
                             (cond-> grouping (.setGroupingSeparator grouping)))
        base               (cond-> (if (or scientific? relation?) "0" "#,##0")
                             (not grouping) (str/replace #"," ""))]
    (fn [value]
      (if (number? value)
        (let [scaled-value      (cond-> (* value (or scale 1))
                                  percent?
                                  (* 100))
              decimals-in-value (digits-after-decimal scaled-value)
              decimal-digits (cond
                               decimals decimals ;; if user ever specifies # of decimals, use that
                               integral? 0
                               currency? (get-in currency/currency [(keyword (or currency "USD")) :decimal_digits])
                               percent?  (min 2 decimals-in-value) ;; 5.5432 -> %554.32
                               :else (if (>= scaled-value 1)
                                       (min 2 decimals-in-value) ;; values greater than 1 round to 2 decimal places
                                       (let [n-figs (sig-figs-after-decimal scaled-value decimal)]
                                         (if (> n-figs 2)
                                           (max 2 (- decimals-in-value (- n-figs 2))) ;; values less than 1 round to 2 sig-dig
                                           decimals-in-value))))
              fmt-str (cond-> base
                        (not (zero? decimal-digits)) (str "." (apply str (repeat decimal-digits "0")))
                        scientific? (str "E0"))
              fmtr (doto (DecimalFormat. fmt-str symbols) (.setRoundingMode RoundingMode/HALF_UP))]
          (map->NumericWrapper
           {:num-value value
            :num-str   (let [inline-currency? (and currency?
                                                   (false? (::mb.viz/currency-in-header column-settings)))]
                         (str (when prefix prefix)
                              (when (and inline-currency? (or (nil? currency-style)
                                                       (= currency-style "symbol")))
                                (get-in currency/currency [(keyword (or currency "USD")) :symbol]))
                              (when (and inline-currency? (= currency-style "code"))
                                (str (get-in currency/currency [(keyword (or currency "USD")) :code]) \space))
                              (cond-> (.format fmtr scaled-value)
                                (and (not currency?) (not decimals))
                                (strip-trailing-zeroes decimal)
                                percent?    (str "%"))
                              (when (and inline-currency? (= currency-style "name"))
                                (str \space (get-in currency/currency [(keyword (or currency "USD")) :name_plural])))
                              (when suffix suffix)))}))
        value))))

(mu/defn format-number :- (ms/InstanceOfClass NumericWrapper)
  "Format a number `n` and return it as a NumericWrapper; this type is used to do special formatting in other
  `pulse.render` namespaces."
  ([n :- number?]
   (map->NumericWrapper {:num-str   (cl-format nil (if (integer? n) "~:d" "~,2f") n)
                         :num-value n}))

  ([value column viz-settings]
   (let [fmttr (number-formatter column viz-settings)]
     (fmttr value))))

(defn graphing-column-row-fns
  "Return a pair of `[get-x-axis get-y-axis]` functions that can be used to get the x-axis and y-axis values in a row,
  or columns, respectively."
  [card data]
  [(or (ui-logic/x-axis-rowfn card data)
       first)
   (or (ui-logic/y-axis-rowfn card data)
       second)])

(defn coerce-bignum-to-int
  "Graal polyglot system (not the JS machine itself, the polyglot system)
  is not happy with BigInts or BigDecimals.
  For more information, this is the GraalVM issue, open a while
  https://github.com/oracle/graal/issues/2737
  Because of this unfortunately they all have to get smushed into normal ints and decimals in JS land."
  [row]
  (for [member row]
    (cond
      ;; this returns true for bigint only, not normal int or long
      (instance? clojure.lang.BigInt member)
      (int member)

      ;; this returns true for bigdec only, not actual normal decimals
      ;; not the clearest clojure native function in the world
      (decimal? member)
      (double member)

      :else
      member)))

(defn row-preprocess
  "Preprocess rows.

  - Removes any rows that have a nil value for the `x-axis-fn` OR `y-axis-fn`
  - Normalizes bigints and bigdecs to ordinary sizes"
  [x-axis-fn y-axis-fn rows]
  (->> rows
       (filter (every-pred x-axis-fn y-axis-fn))
       (map coerce-bignum-to-int)))

(defn format-geographic-coordinates
  "Format longitude/latitude values as 0.00000000° N|S|E|W"
  [lon-or-lat ^double v]
  (let [dir        (case lon-or-lat
                     :type/Latitude (if (neg? v) "S" "N")
                     :type/Longitude (if (neg? v) "W" "E")
                     nil)
        base-value (Math/abs v)]
    (if dir
      (format "%.8f° %s" base-value dir)
      (str v))))

(mu/defn create-formatter
  "Create a formatter for a column based on its timezone, column metadata, and visualization-settings"
  [timezone-id :- [:maybe :string] col visualization-settings]
  (cond
    ;; for numbers, return a format function that has already computed the differences.
    ;; todo: do the same for temporal strings
    (types/temporal-field? col)
    #(datetime/format-temporal-str timezone-id % col visualization-settings)

    (isa? (:semantic_type col) :type/Coordinate)
    (partial format-geographic-coordinates (:semantic_type col))

    ;; todo integer columns with a unit
    (or (isa? (:effective_type col) :type/Number)
        (isa? (:base_type col) :type/Number))
    (number-formatter col visualization-settings)

    :else
    str))
