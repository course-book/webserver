const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const dotenv = require("dotenv");
const amqp = require("amqplib");
const SimpleNodeLogger = require("simple-node-logger");
const mkdirp = require("mkdirp")

const RabbitHandler = require("./rabbitHandler");

// Setup
dotenv.config();
mkdirp("./logs", (error) => {
  if (error) {
    console.log("Unable to construct logs directory");
    process.exit(1);
  }
  initialize();
});

// Use Basic Logger. Have it override if setup completes.
let logger = SimpleNodeLogger.createSimpleLogger();

const handler = new RabbitHandler(process.env.RABBITMQ_HOST, logger);

const app = express();
const port = process.env.PORT || 8080;

/**
 *  Statically send things in /build/
 */
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

  response.status(200).send("<h1> Server is Up </h1>");
});

/**
* Handle User Registration.
*/
app.put("/register", (request, response) => {
  logger.info("registering User");
  const body = request.body;
  const action = "REGISTRATION";
  const username = body.username;
  const password = body.password;

  logger.info(`Registering User username=${username} password=${password}`);

  // TODO: Query before posting message. Is username unique?

  const riakData = {
    action: action,
    ip: request.ip
  };
  handler.sendMessage("riak", JSON.stringify(riakData));

  const mongoData = {
    action: action,
    username: username,
    password: password
  };
  handler.sendMessage("mongo", JSON.stringify(mongoData));
  response.status(201)
    .send("<h1> Register request received </h1>");
});

const initialize = () => {
  const opts = {
    logFilePath: "./logs/server.log",
    timestampFormat: "YYYY-MM-DD HH:mm:ss"
  };
  logger = SimpleNodeLogger.createSimpleLogger(opts);

  app.listen(port, (error) => {
    if (error) {
      logger.error(error);
    } else {
      logger.info(`Webserver is LIVE. ${port}`);
      logger.info(`Rabbitmq Endpoint: ${process.env.RABBITMQ_HOST}`);
    }
  });
}
