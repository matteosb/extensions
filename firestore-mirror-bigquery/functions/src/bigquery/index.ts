/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as bigquery from "@google-cloud/bigquery";
import {
  firestoreToBQTable,
  userSchemaView,
} from "./schema";
import { FirestoreSchema } from "../firestore/index";
import { latestConsistentSnapshotView, latestConsistentSnapshotSchemaView } from "./snapshot";

import { ChangeType, FirestoreEventHistoryTracker, FirestoreDocumentChangeEvent } from "../firestoreEventHistoryTracker";
import * as logs from "../logs";
import { BigQuery } from "@google-cloud/bigquery";

export interface FirestoreBigQueryEventHistoryTrackerConfig {
  collectionPath: string;
  datasetId: string;
  initialized: boolean;
}

/**
 * An interface to BigQuery which handles:
 * - Iniitializing the raw changelog table when the first event gets recorded.
 * - Initializing the latest view over the raw changelog.
 * - Streaming writes into the raw changelog table.
 */
export class FirestoreBigQueryEventHistoryTracker implements FirestoreEventHistoryTracker {
  bq: bigquery.BigQuery;
  tableName: string;
  initialized: boolean;

  constructor(public config: FirestoreBigQueryEventHistoryTrackerConfig) {
    this.bq = new bigquery.BigQuery();
    this.initialized = config.initialized;
    this.tableName = config.collectionPath.replace(/\//g, "_");
  }

  async record(events: FirestoreDocumentChangeEvent[]) {
    if (!this.config.initialized) {
      try {
        await this.initialize(this.config.datasetId, this.tableName);
        this.initialized = true;
      } catch (e) {
        logs.bigQueryErrorRecordingDocumentChange(e);
      }
    }
    const rows = events.map(event => {
      return this.buildDataRow(
        // Use the function's event ID to protect against duplicate executions
        event.eventId,
        event.operation,
        event.timestamp,
        event.documentName,
        event.data);
    });
    await this.insertData(this.config.datasetId, this.tableName, rows);
  }

  /**
   * Ensure that the defined Firestore schema exists within BigQuery and
   * contains the correct information. This is invoked for the first time when
   * the first document change event is recorded.
   */
  async initialize(datasetId: string, tableName: string) {
    const rawTable = raw(tableName);

    await this.initializeDataset(datasetId);
    await this.initializeChangelog(datasetId, rawTable);
    await this.initializeLatestView(datasetId, rawTable);
  };

  buildDataRow(
    eventId: string,
    changeType: ChangeType,
    timestamp: Date,
    document_name: string,
    data?: Object
  ): bigquery.RowMetadata {
    // This must match firestoreToBQTable().
    return {
      timestamp: timestamp.toISOString(),
      eventId: eventId,
      document_name: document_name,
      operation: ChangeType[changeType],
      data: JSON.stringify(data),
    };
  };

  /**
   * Insert a row of data into the BigQuery `raw` data table
   */
  async insertData(
    datasetId: string,
    collectionTableName: string,
    rows: bigquery.RowMetadata[]
  ) {
    const name = changeLog(raw(collectionTableName));
    const dataset = this.bq.dataset(datasetId);
    const table = dataset.table(name);
    const rowCount = rows.length;

    logs.dataInserting(rowCount);
    await table.insert(rows);
    logs.dataInserted(rowCount);
  };

  /**
   * Check that the specified dataset exists, and create it if it doesn't.
   */
  async initializeDataset(datasetId: string): Promise<bigquery.Dataset> {
    const dataset = this.bq.dataset(datasetId);
    const [datasetExists] = await dataset.exists();
    if (datasetExists) {
      logs.bigQueryDatasetExists(datasetId);
    } else {
      logs.bigQueryDatasetCreating(datasetId);
      await dataset.create();
      logs.bigQueryDatasetCreated(datasetId);
    }
    return dataset;
  };

  /**
   * Check that the table exists within the specified dataset, and create it
   * if it doesn't.  If the table does exist, validate that the BigQuery schema
   * is correct and add any missing fields.
   */
  async initializeChangelog(
    datasetId: string,
    tableName: string,
  ): Promise<bigquery.Table> {
    const changelogName = changeLog(tableName);
    const dataset = this.bq.dataset(datasetId);
    let table = dataset.table(changelogName);
    const [tableExists] = await table.exists();

    if (tableExists) {
      logs.bigQueryTableAlreadyExists(table.id, dataset.id);
    } else {
      logs.bigQueryTableCreating(changelogName);
      const options = {
        // `friendlyName` needs to be here to satisfy TypeScript
        friendlyName: changelogName,
        schema: firestoreToBQTable(),
      };
      await table.create(options);
      logs.bigQueryTableCreated(changelogName);
    }
    return table;
  };

  /**
   * Create a view over a table storing a change log of Firestore documents
   * which contains only latest version of all live documents in the mirrored
   * collection.
   */
  async initializeLatestView(
    datasetId: string,
    tableName: string
  ): Promise<bigquery.Table> {
    let viewName = latest(tableName);
    const dataset = this.bq.dataset(datasetId);
    let view = dataset.table(viewName);
    const [viewExists] = await view.exists();

    if (viewExists) {
      logs.bigQueryViewAlreadyExists(view.id, dataset.id);
    } else {
      logs.bigQueryViewCreating(viewName);
      const options = {
        friendlyName: viewName,
        view: latestConsistentSnapshotView(datasetId, changeLog(tableName))
      };
      await view.create(options);
      logs.bigQueryViewCreated(viewName);
    }
    return view;
  };
}

export function raw(tableName: string): string { return `${tableName}_raw`; };
export function changeLog(tableName: string): string { return `${tableName}_changelog`; }
export function latest(tableName: string): string { return `${tableName}_latest`; };