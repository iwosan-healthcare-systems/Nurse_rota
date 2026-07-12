module.exports = {
  apps: [
    {
      name: 'nurse-api',
      script: 'server.js',
      cwd: '/home/nrotaiwosanhealt/nurse-api',
      instances: 'max',      // one worker per CPU core
      exec_mode: 'cluster',  // share port across workers — handles 250+ concurrent users
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
    {
      name: 'nurse-api-uat',
      script: 'server.js',
      cwd: '/home/nrotaiwosanhealt/nurse-api-uat',
      instances: 1,          // UAT is low-traffic; single instance is fine
      exec_mode: 'fork',
      env_uat: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
    },
  ],
};
