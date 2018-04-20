const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const dotenv = require("dotenv");
const amqp = require("amqplib");
const uuidv4 = require('uuid/v4');
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

const uuidMap = new Map();

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

  const uuid = uuidv4();
  const mongoData = {
    action: action,
    username: username,
    password: password,
    uuid: uuid
  };
  handler.sendMessage("mongo", JSON.stringify(mongoData));
  uuidMap.set(uuid, response);
});

app.post("/login", (request, response) => {
  logger.info("Not Implemented");
  response.status(500)
    .send("Login is not implemented");
});

app.post("/respond", (request, response) => {
  logger.info("responding to user");
  const body = request.body;
  const uuid = body.uuid;
  const statusCode = body.statusCode;
  const message = body.message;

  const initResponse = uuidMap.get(uuid);
  if (initResponse) {
    initResponse.status(statusCode)
      .send(body.message);
    uuidMap.delete(uuid);
  }
  response.status(200)
    .send();
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
