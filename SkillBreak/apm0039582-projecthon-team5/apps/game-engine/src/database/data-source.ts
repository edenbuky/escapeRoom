import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions, loadEngineDatabaseConfig } from '../config/config';

export const AppDataSource = new DataSource(databaseOptions(loadEngineDatabaseConfig()));
