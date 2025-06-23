import winston from 'winston';
import axios from 'axios';

// Create winston logger with comprehensive configuration
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    return `[${timestamp}] ${level}: ${stack || message}`;
  })
);

const logger = winston.createLogger({
  format: customFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        customFormat
      ),
      level: 'info',
    }),
    // File transport for all logs
    new winston.transports.File({ 
      filename: 'load-test.log',
      format: customFormat,
      level: 'debug',
    }),
    // Separate file for errors
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error',
      format: customFormat
    })
  ],
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: 'exceptions.log',
      format: customFormat
    }),
  ],
  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: 'rejections.log',
      format: customFormat
    }),
  ],
  exitOnError: false
});

export { logger };

export function prettyPrintError(message: string, error: unknown) {
  if (axios.isAxiosError(error)) {
    logger.error(`${message} (${error.status}): ${error.response?.data?.message || error.message}`);
    return;
  }

  logger.error(`${message}: ${error instanceof Error ? error.message : error}`);
}

