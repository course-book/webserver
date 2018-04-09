const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const SimpleNodeLogger = require('simple-node-logger');

opts = {
    logFilePath: "./logs/server.log",
    timestampFormat: "YYYY-MM-DD HH:mm:ss"
};
const logger = SimpleNodeLogger.createSimpleLogger(opts);
const app = express();

const port = process.env.PORT || 8080;


app.use(express.static(path.join(__dirname, "/build"), {maxAge: "1w"}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));

/**
* Health endpoint.
*
*/
app.get("/health", (request, response) => {
  logger.info(`hostname: ${request.hostname}`);
  logger.info(`ip: ${request.ip}`);

  response.status(200)
    .send("<h1> Server is Up </h1>");
});

app.put("/register", (request, response) => {
  logger.info("REGISTERING User");

  response.status(201)
    .send("<h1> Register request received </h1>");
});

/*
  Listen to connections.
*/
app.listen(port, (error) => {
  if (error) {
    logger.error(error);
  } else {
    logger.info(`Webserver is LIVE. ${port}`);
  }
});
