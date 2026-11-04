import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../config/config';
import { RefreshFamily } from './entities/refresh-family.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';
import { InitialSchema1740000000000 } from './migrations/1740000000000-InitialSchema';

export const AppDataSource = new DataSource({
  ...databaseOptions(),
  entities: [User, RefreshFamily, RefreshToken],
  migrations: [InitialSchema1740000000000],
});