#!/usr/bin/env node

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

import * as firebase from "firebase-admin";
import * as fs from "fs";
import * as program from "commander";
import * as util from "util";

import {
  ChangeType,
  FirestoreBigQueryEventHistoryTracker,
  FirestoreDocumentChangeEvent,
} from './../../../firestore-bigquery-change-tracker/src/index';

// For reading cursor position.
const exists = util.promisify(fs.exists);
const write = util.promisify(fs.writeFile);
const read = util.promisify(fs.readFile);
const unlink = util.promisify(fs.unlink);

// const BIGQUERY_VALID_CHARACTERS = /^[a-zA-Z0-9_]+$/;
// const FIRESTORE_VALID_CHARACTERS = /^[^\/]+$/;
//
// const FIRESTORE_COLLECTION_NAME_MAX_CHARS = 6144;
// const BIGQUERY_RESOURCE_NAME_MAX_CHARS = 1024;

const FIRESTORE_DEFAULT_DATABASE = "(default)";
//
// const validateInput = (
//   value: string,
//   name: string,
//   regex: RegExp,
//   sizeLimit: number
// ) => {
//   if (!value || value === "" || value.trim() === "") {
//     return `Please supply a ${name}`;
//   }
//   if (value.length >= sizeLimit) {
//     return `${name} must be at most ${sizeLimit} characters long`;
//   }
//   if (!value.match(regex)) {
//     return `The ${name} must only contain letters or spaces`;
//   }
//   return true;
// };
//
// const questions = [
//   {
//     message: "What is your Firebase project ID?",
//     name: "projectId",
//     type: "input",
//     validate: (value) =>
//       validateInput(
//         value,
//         "project ID",
//         FIRESTORE_VALID_CHARACTERS,
//         FIRESTORE_COLLECTION_NAME_MAX_CHARS
//       ),
//   },
//   {
//     message:
//       "What is the path of the the Cloud Firestore Collection you would like to import from? " +
//       "(This may, or may not, be the same Collection for which you plan to mirror changes.)",
//     name: "sourceCollectionPath",
//     type: "input",
//     validate: (value) =>
//       validateInput(
//         value,
//         "collection path",
//         FIRESTORE_VALID_CHARACTERS,
//         FIRESTORE_COLLECTION_NAME_MAX_CHARS
//       ),
//   },
//   {
//     message:
//       "What is the ID of the BigQuery dataset that you would like to use? (A dataset will be created if it doesn't already exist)",
//     name: "datasetId",
//     type: "input",
//     validate: (value) =>
//       validateInput(
//         value,
//         "dataset",
//         BIGQUERY_VALID_CHARACTERS,
//         BIGQUERY_RESOURCE_NAME_MAX_CHARS
//       ),
//   },
//   {
//     message:
//       "What is the identifying prefix of the BigQuery table that you would like to import to? (A table will be created if one doesn't already exist)",
//     name: "tableId",
//     type: "input",
//     validate: (value) =>
//       validateInput(
//         value,
//         "table",
//         BIGQUERY_VALID_CHARACTERS,
//         BIGQUERY_RESOURCE_NAME_MAX_CHARS
//       ),
//   },
//   {
//     message:
//       "How many documents should the import stream into BigQuery at once?",
//     name: "batchSize",
//     type: "input",
//     default: 300,
//     validate: (value) => {
//       return parseInt(value, 10) > 0;
//     },
//   },
// ];


const isSubCollection = (sourceCollectionPath: string): boolean => {
  return sourceCollectionPath.indexOf("/{") !== -1;
};

/**
 * Take a sourceCollectionPath with a wildcard, e.g. events/{eventid}/rounds/{roundid}/participants
 * and turn it into a regular expression suitable for filtering on document refs.
 */
const regexForSubCollectionPath = (sourceCollectionPath: string): RegExp => {
  return RegExp(sourceCollectionPath.replace(/\{([A-Za-z_]+)\}/g, "[A-Za-z0-9]+"))
};

const run = async (): Promise<number> => {
  program
      .option("--projectId <string>", "firebase projectid")
      .option("--sourceCollectionPath <string>", "collection patch e.g. /events/{eventid}/posts")
      .option("--datasetId <string>", "bigquery dataset to import into", "firestore_export")
      .option("--tableId <string>", "table prefix")
      .parse(process.argv);
  const {
    projectId,
    sourceCollectionPath,
    datasetId,
    tableId,
  } = program;

  const batch = 300;
  const rawChangeLogName = `${tableId}_raw_changelog`;

  // Initialize Firebase
  firebase.initializeApp({
    credential: firebase.credential.applicationDefault(),
    databaseURL: `https://${projectId}.firebaseio.com`,
  });
  // Set project ID so it can be used in BigQuery intialization
  process.env.PROJECT_ID = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;

  // We pass in the application-level "tableId" here. The tracker determines
  // the name of the raw changelog from this field.
  const dataSink = new FirestoreBigQueryEventHistoryTracker({
    tableId: tableId,
    datasetId: datasetId,
  });

  console.log(
    `Importing data from Cloud Firestore Collection: ${sourceCollectionPath}, to BigQuery Dataset: ${datasetId}, Table: ${rawChangeLogName}`
  );

  // Build the data row with a 0 timestamp. This ensures that all other
  // operations supersede imports when listing the live documents.
  let cursor;

  const normalizedSourceCollectionPath = sourceCollectionPath.replace(/\/\{.*?\}\//g, "_")
  let cursorPositionFile =
    __dirname +
    `/from-${normalizedSourceCollectionPath}-to-${projectId}_${datasetId}_${rawChangeLogName}`;
  if (await exists(cursorPositionFile)) {
    let cursorDocumentId = (await read(cursorPositionFile)).toString();
    cursor = await firebase
      .firestore()
      .collection(sourceCollectionPath)
      .doc(cursorDocumentId)
      .get();
    console.log(
      `Resuming import of Cloud Firestore Collection ${sourceCollectionPath} from document ${cursorDocumentId}.`
    );
  }

  let totalDocsRead = 0;
  let totalRowsImported = 0;

  do {
    if (cursor) {
      await write(cursorPositionFile, cursor.id);
    }

    let query;

    // Upstream does not support importing documents in subcollections
    // See: https://github.com/firebase/extensions/issues/17
    // We build on top of the work-around described in that ticket by filtering
    // documents in the collection group based on the wild-card path passed
    // in by the user. This is necessary because collection group queries
    // will find documents in all collections by that name, e.g.
    // collection group "messages" will match documents in both
    // events/{eventid}/messages and threads/{threadid}/messages
    const subCollection = isSubCollection(sourceCollectionPath);
    if (subCollection) {
      const collectionGroup = sourceCollectionPath.split("/").slice(-1)[0];
      query = firebase
          .firestore()
          .collectionGroup(collectionGroup)
          .limit(batch);
    } else {
      query = firebase
          .firestore()
          .collection(sourceCollectionPath)
          .limit(batch);
    }

    if (cursor) {
      query = query.startAfter(cursor);
    }
    const snapshot = await query.get();
    const docs = snapshot.docs;
    if (docs.length === 0) {
      break;
    }
    totalDocsRead += docs.length;
    cursor = docs[docs.length - 1];
    const subCollectionRegex = regexForSubCollectionPath(sourceCollectionPath);
    if (subCollection) {
      console.log(
          "Processing subcollection, documents will be filtered using regex:",
          subCollectionRegex
      );
    }
    const rows: FirestoreDocumentChangeEvent[] = docs
        .filter((snapshot) => {
          return !subCollection || subCollectionRegex.test(snapshot.ref.path)
        })
        .map((snapshot) => {
          return {
            timestamp: new Date(0).toISOString(), // epoch
            operation: ChangeType.IMPORT,
            documentName: `projects/${projectId}/databases/${FIRESTORE_DEFAULT_DATABASE}/documents/${
                snapshot.ref.path
            }`,
            eventId: "",
            data: snapshot.data(),
          };
        });
    await dataSink.record(rows);
    totalRowsImported += rows.length;
    console.log("rows", rows.length, "docs read", totalDocsRead,"docs imported", totalRowsImported);
  } while (true);

  try {
    await unlink(cursorPositionFile);
  } catch (e) {
    console.log(
      `Error unlinking journal file ${cursorPositionFile} after successful import: ${e.toString()}`
    );
  }

  return totalRowsImported;
};

run()
  .then((rowCount) => {
    console.log("---------------------------------------------------------");
    console.log(`Finished importing ${rowCount} Firestore rows to BigQuery`);
    console.log("---------------------------------------------------------");
    process.exit();
  })
  .catch((error) => {
    console.error(
      `Error importing Collection to BigQuery: ${error.toString()}`
    );
    process.exit(1);
  });
