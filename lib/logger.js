const winston = require('winston')

const format = winston.format.combine(winston.format.colorize(), winston.format.simple())

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format, stderrLevels: [ 'info', 'warn', 'debug', 'trace', 'error' ] })
  ]
})

module.exports = logger
