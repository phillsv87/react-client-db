import { DbConfig } from "../db-types";

const SQLite=require('react-native-sqlite-2');//eslint-disable-line

export default function openDatabaseReactNativeSqlite2(config:Required<DbConfig>)
{
    return SQLite.default.openDatabase(config.databaseName);
}
