
import * as SQLite from 'expo-sqlite';
import { DbConfig } from '../db-types';

export default function openDatabaseExpoSqlite(config:Required<DbConfig>)
{
    return SQLite.openDatabase(config.databaseName)
}
