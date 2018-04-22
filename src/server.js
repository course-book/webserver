const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const dotenv = require("dotenv");
const amqp = require("amqplib");
const uuidv4 = require('uuid/v4');
const SimpleNodeLogger = require("simple-node-logger");
const mkdirp = require("mkdirp");
const jwt = require("jsonwebtoken");
const rp = require("request-promise");
dotenv.config();

// Classes
const RabbitHandler = require("./rabbitHandler");
const Authenticator = require("./authenticator");
const RegistrationResponder = require("./registrationResponder");

// Setup
mkdirp("./logs", (error) => {
  if (error) {
    console.log("Unable to construct logs directory");
    process.exit(1);
  }
  initialize();
});

// Application Instantiation
const app = express();

// Parsing Environment Constants.
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "course-book-secret";
const MONGO_HOST = process.env.MONGO_HOST;

// Use Basic Logger. Have it override if setup completes.
let logger = SimpleNodeLogger.createSimpleLogger();

// Handler Instantiation.
const handler = new RabbitHandler(process.env.RABBITMQ_HOST, logger);
const authenticator = new Authenticator(JWT_SECRET);
const registrationResponder = new RegistrationResponder(authenticator);

// Map to be used in conjunction with `/respond` (force synchronous endpoints)
const uuidMap = new Map();

/**
 *  Statically send things in /build/
 */
app.use(express.static(path.join(__dirname, "/build"), {maxAge: "1w"}));

/**
 *  Middleware setup for parsing JSON bodies.
 */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));

/**
* Health endpoint.
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
  logger.info("[ PUT ] registering User");
  const body = request.body;
  const action = "REGISTRATION";
  const username = body.username;
  const password = body.password;

  logger.info(`Registering User username=${username} password=${password}`);

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
  // NOTE: This will be handled via `/respond` endpoint to force synchronous response
  // while using Rabbitmq.
});

/**
 *  Handle Course Creation
 */
app.put("/course", (request, response) => {
  logger.info("[ PUT ] course creation");

  const token = request.get("Authorization");
  logger.info(`Got token ${token}`);
  authenticator.verify(token)
    .then((payload) => {
      const action = "COURSE_CREATE";
      const riakData = {
        action: action,
        ip: request.ip,
        username: payload.username
        // TODO: figure out what else is sent.
      };
      handler.sendMessage("riak", JSON.stringify(riakData));

      const uuid = uuidv4();
      const mongoData = {
        action: action,
        username: payload.username,
        uuid: uuid
      };
      handler.sendMessage("mongo", JSON.stringify(mongoData));
      response.status(202).send("Course has been queued for processing");
    })
    .catch((error) => response.status(401).send(error.message));
});

/**
 *  Handle User Login.
 */
app.post("/login", (request, response) => {
  logger.info(`[ POST ] login ${request.ip}`);

  const body = request.body;
  const options = {
    method: "POST",
    uri: `${MONGO_HOST}/login`,
    body: body,
    json: true
  }
  rp(options).then((mongoResponse) => {
    logger.info(`Mongo responded with ${mongoResponse}`);
    if (monogResponse.authorized) {
      const payload = {
        username: body.username
      };
      const token = authenticator.sign(payload);
      response.status(200).send(token);
    }
  }).catch((error) => {
    response.status(500).send(error.message);
  });
});

/**
 *  Handle synchronous responses.
 */
app.post("/respond", (request, response) => {
  logger.info("[ POST ] respond to user");
  const body = request.body;
  const uuid = body.uuid;
  const action = body.action;

  const initResponse = uuidMap.get(uuid);
  if (initResponse) {
    switch (action) {
      case "REGISTRATION":
        registrationResponder.respond(initResponse, body);
        break;
      default:
        logger.warn(`Unrecognized action ${action}`);
        initResponse.status(500).send("Unexpected response action");
        break;
    }
    uuidMap.delete(uuid);
  }

  response.status(200)
    .send();
});

/**
 *  Start the server.
 */
const initialize = () => {
  const opts = {
    logFilePath: "./logs/server.log",
    timestampFormat: "YYYY-MM-DD HH:mm:ss"
  };
  logger = SimpleNodeLogger.createSimpleLogger(opts);

  app.listen(PORT, (error) => {
    if (error) {
      logger.error(error);
      process.exit(1);
    } else {
      logger.info(`Webserver is LIVE. ${PORT}`);
      logger.info(`Rabbitmq Endpoint: ${process.env.RABBITMQ_HOST}`);
    }
  });
}
