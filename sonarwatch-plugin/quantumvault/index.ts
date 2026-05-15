import { Platform } from '@sonarwatch/portfolio-core';
import { Fetcher } from '../../Fetcher';
import { platform } from './constants';
import positionsFetcher from './positionsFetcher';

export const platforms: Platform[] = [platform];
export const jobs = [];
export const fetchers: Fetcher[] = [positionsFetcher];
