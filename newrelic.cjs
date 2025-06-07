// Load dotenv directly in the config file
import 'dotenv/config';

// Debug line to check the license key
console.log('License key from env in newrelic.cjs:', process.env.NEW_RELIC_LICENSE_KEY);

exports.config = {
  app_name: ['Sketch_Music'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  distributed_tracing: {
    enabled: true
  },
  transaction_tracer: {
    enabled: true
  },
  logging: {
    level: 'info'
  },
  allow_all_headers: true,
  attributes: {
    exclude: [
      'request.headers.cookie',
      'request.headers.authorization',
      'request.headers.proxyAuthorization',
      'request.headers.setCookie*',
      'request.headers.x*',
      'response.headers.cookie',
      'response.headers.authorization',
      'response.headers.proxyAuthorization',
      'response.headers.setCookie*',
      'response.headers.x*'
    ]
  }
};