import { openDB, IDBPDatabase } from 'idb';
import { Problem } from '../services/geminiService';

const DB_NAME = 'ProblemBankDB';
const DB_VERSION = 2;

interface ProblemMetadata {
  problem_id: string;
  hash: string;
}

let dbPromise: Promise<IDBPDatabase>;

export const initDB = () => {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        if (oldVersion < 2) {
          if (db.objectStoreNames.contains('problems')) db.deleteObjectStore('problems');
          if (db.objectStoreNames.contains('metadata')) db.deleteObjectStore('metadata');
          db.createObjectStore('problems', { keyPath: 'problem_id' });
          db.createObjectStore('metadata', { keyPath: 'problem_id' });
        }
      },
    });
  }
  return dbPromise;
};

export const getLocalProblems = async (): Promise<Problem[]> => {
  const db = await initDB();
  return db.getAll('problems');
};

export const getLocalMetadata = async (): Promise<ProblemMetadata[]> => {
  const db = await initDB();
  return db.getAll('metadata');
};

export const saveProblem = async (problem: Problem, hash: string) => {
  const db = await initDB();
  const tx = db.transaction(['problems', 'metadata'], 'readwrite');
  await tx.objectStore('problems').put(problem);
  await tx.objectStore('metadata').put({ problem_id: problem.problem_id, hash });
  await tx.done;
};

export const deleteProblem = async (problem_id: string) => {
  const db = await initDB();
  const tx = db.transaction(['problems', 'metadata'], 'readwrite');
  await tx.objectStore('problems').delete(problem_id);
  await tx.objectStore('metadata').delete(problem_id);
  await tx.done;
};
