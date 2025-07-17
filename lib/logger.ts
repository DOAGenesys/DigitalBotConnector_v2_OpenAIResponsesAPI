import pino from 'pino';
import { getConfig } from './config';

const config = getConfig();
const logger = pino({ level: config.LOG_LEVEL });

export default logger;
