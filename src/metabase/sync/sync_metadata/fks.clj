(ns metabase.sync.sync-metadata.fks
  "Logic for updating FK properties of Fields from metadata fetched from a physical DB."
  (:require
   [honey.sql :as sql]
   [metabase.db.connection :as mdb.connection]
   [metabase.driver :as driver]
   [metabase.driver.util :as driver.u]
   [metabase.models.table :as table]
   [metabase.sync.fetch-metadata :as fetch-metadata]
   [metabase.sync.interface :as i]
   [metabase.sync.util :as sync-util]
   [metabase.util :as u]
   [metabase.util.log :as log]
   [metabase.util.malli :as mu]
   [toucan2.core :as t2]
   [toucan2.realize :as t2.realize]))

(defn ^:private mark-fk-sql
  "Returns [sql & params] for [[mark-fk!]] according to the application DB's dialect."
  [db-id {:keys [fk-table-name
                 fk-table-schema
                 fk-column-name
                 pk-table-name
                 pk-table-schema
                 pk-column-name]}]
  (let [field-id-query (fn [db-id table-schema table-name column-name]
                         {:select [[[:min :f.id] :id]]
                          ;; Cal 2024-03-04: We use `min` to limit this subquery to one result (limit 1 isn't allowed
                          ;; in subqueries in MySQL) because it's possible for schema, table, or column names to be
                          ;; non-unique when lower-cased for some DBs. We have been doing case-insensitive matching
                          ;; since #5510 so this preserves behaviour to avoid possible regressions.
                          ;; It's possible this is to avoid
                          :from   [[:metabase_field :f]]
                          :join   [[:metabase_table :t] [:= :f.table_id :t.id]]
                          :where  [:and
                                   [:= :t.db_id db-id]
                                   [:= [:lower :f.name] (u/lower-case-en column-name)]
                                   [:= [:lower :t.name] (u/lower-case-en table-name)]
                                   [:= [:lower :t.schema] (some-> table-schema u/lower-case-en)]
                                   [:= :f.active true]
                                   [:not= :f.visibility_type "retired"]
                                   [:= :t.active true]
                                   [:= :t.visibility_type nil]]})
        fk-field-id-query (field-id-query db-id fk-table-schema fk-table-name fk-column-name)
        pk-field-id-query (field-id-query db-id pk-table-schema pk-table-name pk-column-name)
        q (case (mdb.connection/db-type)
            :mysql
            {:update [:metabase_field :f]
             :join   [[fk-field-id-query :fk] [:= :fk.id :f.id]
                      ;; Only update if either:
                      ;; - fk_target_field_id is NULL and the new target is not NULL
                      ;; - fk_target_field_id is not NULL but the new target is different and not NULL
                      [pk-field-id-query :pk]
                      [:= :f.fk_target_field_id nil]]
             :set    {:fk_target_field_id :pk.id
                      :semantic_type      "type/FK"}}
            :postgres
            {:update [:metabase_field :f]
             :from   [[fk-field-id-query :fk]]
             :join   [[pk-field-id-query :pk] true]
             :set    {:fk_target_field_id :pk.id
                      :semantic_type      "type/FK"}
             :where  [:and
                      [:= :fk.id :f.id]
                      [:= :f.fk_target_field_id nil]]}
            :h2
            {:update [:metabase_field :f]
             :set    {:fk_target_field_id pk-field-id-query
                      :semantic_type      "type/FK"}
             :where  [:and
                      [:= :f.id fk-field-id-query]
                      [:not= pk-field-id-query nil]
                      [:= :f.fk_target_field_id nil]]})]
    (sql/format q :dialect (mdb.connection/quoting-style (mdb.connection/db-type)))))

(mu/defn ^:private mark-fk!
  "Updates the `fk_target_field_id` of a Field. Returns 1 if the Field was successfully updated, 0 otherwise."
  [database :- i/DatabaseInstance
   metadata :- i/FKMetadataEntry]
  (u/prog1 (t2/query-one (mark-fk-sql (:id database) metadata))
  (when (= <> 1)
    (log/info (u/format-color 'cyan "Marking foreign key from %s %s -> %s %s"
                              (sync-util/table-name-for-logging :name (:fk-table-name metadata)
                                                                :schema (:fk-table-schema metadata))
                              (sync-util/field-name-for-logging :name (:fk-column-name metadata))
                              (sync-util/table-name-for-logging :name (:fk-table-name metadata)
                                                                :schema (:fk-table-schema metadata))
                              (sync-util/field-name-for-logging :name (:pk-column-name metadata)))))))

(mu/defn sync-fks-for-db!
  "Sync the foreign keys for a `database`."
  [database :- i/DatabaseInstance]
  (sync-util/with-error-handling (format "Error syncing FKs for %s" (sync-util/name-for-logging database))
    (let [schema-names (sync-util/db->sync-schemas database)
          fk-metadata  (fetch-metadata/fk-metadata database :schema-names schema-names)]
      (transduce (map (fn [x]
                        (let [[updated failed] (try [(mark-fk! database x) 0]
                                                    (catch Exception e
                                                      (log/error e)
                                                      [0 1]))]
                          {:total-fks    1
                           :updated-fks  updated
                           :total-failed failed})))
                 (partial merge-with +)
                 {:total-fks    0
                  :updated-fks  0
                  :total-failed 0}
                 fk-metadata))))

(mu/defn sync-fks-for-table!
  "Sync the foreign keys for a specific `table`."
  ([table :- i/TableInstance]
   (sync-fks-for-table! (table/database table) table))

  ([database :- i/DatabaseInstance
    table    :- i/TableInstance]
   (sync-util/with-error-handling (format "Error syncing FKs for %s" (sync-util/name-for-logging table))
     (let [fk-metadata (fetch-metadata/table-fk-metadata database table)]
       {:total-fks   (count fk-metadata)
        :updated-fks (sync-util/sum-numbers #(mark-fk! database %) fk-metadata)}))))

(mu/defn sync-fks!
  "Sync the foreign keys in a `database`. This sets appropriate values for relevant Fields in the Metabase application
  DB based on values from the `FKMetadata` returned by [[metabase.driver/describe-table-fks]].

  If the driver supports the `:describe-fks` feature, [[metabase.driver/describe-fks]] is used to fetch the FK metadata.

  This function also sets all the tables that should be synced to have `initial-sync-status=complete` once the sync is done."
  [database :- i/DatabaseInstance]
  (u/prog1 (if (driver/database-supports? (driver.u/database->driver database) :describe-fks database)
             (sync-fks-for-db! database)
             (reduce (fn [update-info table]
                       (let [table         (t2.realize/realize table)
                             table-fk-info (sync-fks-for-table! database table)]
                         (if (instance? Exception table-fk-info)
                           (update update-info :total-failed inc)
                           (merge-with + update-info table-fk-info))))
                     {:total-fks    0
                      :updated-fks  0
                      :total-failed 0}
                     (sync-util/db->reducible-sync-tables database)))
    ;; Mark the table as done with its initial sync once this step is done even if it failed, because only
    ;; sync-aborting errors should be surfaced to the UI (see
    ;; `:metabase.sync.util/exception-classes-not-to-retry`).
    (sync-util/set-initial-table-sync-complete-for-db! database)))
