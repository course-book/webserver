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
const CourseCreationResponder = require("./courseCreationResponder");

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
const courseCreationResponder = new CourseCreationResponder();

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

app.all("/*", (request, response, next) => {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  response.header("Access-Control-Allow-Methods", "GET, POST, PUT");
  next();
});

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

  const body = request.body;
  const name = body.name;
  const sources = body.sources;
  const description = body.description;
  const shortDescription = body.shortDescription || "";

  if (!name) {
    response.status(400)
      .send("Course name is missing.");
    return;
  } else if (!sources) {
    response.status(400)
      .send("Course has no sources.");
    return;
  } else if (!description) {
    response.status(400)
      .send("Course has no description.");
    return;
  }

  logger.info(`Got token ${token}`);
  authenticator.verify(token)
    .then((payload) => {
      const action = "COURSE_CREATE";
      const riakData = {
        action: action,
        ip: request.ip,
        username: payload.username,
        name: name,
      };
      handler.sendMessage("riak", JSON.stringify(riakData));

      const uuid = uuidv4();
      const mongoData = {
        action: action,
        author: payload.username,
        uuid: uuid,
        name: name,
        sources: sources,
        description: description,
        shortDescription: shortDescription
      };
      handler.sendMessage("mongo", JSON.stringify(mongoData));
      uuidMap.set(uuid, response);
      // Note: Mongo needs to process this and verify that it is not a duplicate.
    })
    .catch((error) => response.status(401).send(error.message));
});

/**
 *  Handle User Login.
 */
app.post("/login", (request, response) => {
  logger.info(`[ LOGIN ] ip ${request.ip}`);

  const body = request.body;
  const options = {
    method: "POST",
    uri: `${MONGO_HOST}/login`,
    body: body,
    json: true
  };
  rp(options)
    .then((mongoResponse) => {
      logger.info(`[ LOGIN ] Mongo responded with ${JSON.stringify(mongoResponse)}`);
      let message = mongoResponse.message;
      if (mongoResponse.authorized) {
        const payload = { username: body.username };
        message = authenticator.sign(payload);
      }
      response.status(mongoResponse.statusCode)
        .send(message);
    }).catch((error) => response.status(500).send(error.message));
});

/**
 *  Handle synchronous responses.
 */
app.post("/respond", (request, response) => {
  logger.info("[ POST ] respond to user");
  const body = request.body;
  const uuid = body.uuid;
  const action = body.action;

  logger.info(`[ RESPOND ] ${JSON.stringify(body)}`);

  const initResponse = uuidMap.get(uuid);
  if (initResponse) {
    switch (action) {
      case "REGISTRATION":
        registrationResponder.respond(initResponse, body);
        break;
      case "COURSE_CREATE":
        courseCreationResponder.respond(initResponse, body);
        break;
      default:
        logger.warn(`Unrecognized action ${action}`);
        initResponse.status(500).send("Unexpected response action");
        break;
    }
    uuidMap.delete(uuid);
  }

  logger.info("[ RESPOND ] Responded to user");
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
