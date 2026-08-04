const path = require("path");

module.exports = {
  apps: [
    {
      name: "nurse-api",
      script: path.join(__dirname, "server.js"),
      instances: "max", // one worker per CPU core
      exec_mode: "cluster", // share port across workers — handles 250+ concurrent users
      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },
    },
  ],
};
