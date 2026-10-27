import { pool } from '../db';
import { SignalBotCloseIntentStorage } from './signal-bot-close-intent-storage';

export const closeIntentStore = new SignalBotCloseIntentStorage(pool);
