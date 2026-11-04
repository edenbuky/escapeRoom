import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions, loadEngineConfig } from '../config/config';

export const AppDataSource = new DataSource(databaseOptions(loadEngineConfig()));
