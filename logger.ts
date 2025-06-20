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
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        customFormat
      )
    }),
    // File transport for all logs
    new winston.transports.File({ 
      filename: 'load-test.log',
      format: customFormat
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

// Export winston logger instance for direct use if needed
export { logger };

// Maintain backward compatibility with existing API
export function prettyPrintError(message: string, error: unknown) {
  if (axios.isAxiosError(error)) {
    logger.error(`${message} (${error.status}): ${error.response?.data?.message || error.message}`);
    return;
  }

  logger.error(`${message}: ${error instanceof Error ? error.message : error}`);
}

export function log(message: string) {
  logger.info(message);
}

// Additional utility functions for different log levels
export function logError(message: string, error?: unknown) {
  if (error) {
    logger.error(message, { error });
  } else {
    logger.error(message);
  }
}

export function logWarn(message: string) {
  logger.warn(message);
}

export function logDebug(message: string) {
  logger.debug(message);
}

export function logInfo(message: string) {
  logger.info(message);
}