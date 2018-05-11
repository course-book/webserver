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
const RabbitHandler = require("./RabbitHandler");
const Authenticator = require("./Authenticator");
const RegistrationResponder = require("./responder/RegistrationResponder");
const CreationResponder = require("./responder/CreationResponder");

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
const RIAK_HOST = process.env.RIAK_HOST;

// Use Basic Logger. Have it override if setup completes.
let logger = SimpleNodeLogger.createSimpleLogger();

// Handler Instantiation.
const handler = new RabbitHandler(process.env.RABBITMQ_HOST, logger);
const authenticator = new Authenticator(JWT_SECRET);
const registrationResponder = new RegistrationResponder(authenticator);
const courseCreationResponder = new CreationResponder("course");
const wishCreationResponder = new CreationResponder("wish");

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
* Health
*/
app.get("/health", (request, response) => {
  const logTag = "HEALTH";
  logger.info(`[ ${logTag} ] hostname: ${request.hostname} | ip ${request.ip}`);
  response.status(200)
    .send("<h1> Server is Up </h1>");
});

/**
* User Registration
*/
app.put("/register", (request, response) => {
  const logTag = "REGISTER";
  logger.info(`[ ${logTag} ] registering User`);
  const body = request.body;
  const action = "REGISTRATION";
  const username = body.username;
  const password = body.password;

  logger.info(`[ ${logTag} ] Registering User username=${username} password=${password}`);

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
 *  User Login
 */
app.post("/login", (request, response) => {
  const logTag = "LOGIN";
  const body = request.body;
  logger.info(`[ ${logTag} ] ip ${request.ip}`);

  const riakData = {
    action: logTag,
    ip: request.ip,
    username: body.username
  };
  handler.sendMessage("riak", JSON.stringify(riakData));
  const options = {
    method: "POST",
    uri: `${MONGO_HOST}/login`,
    body: body,
    json: true
  };
  rp(options)
    .then((mongoResponse) => {
      logger.info(`[ ${logTag} ] Mongo responded with ${JSON.stringify(mongoResponse)}`);
      let message = mongoResponse.message;
      if (mongoResponse.authorized) {
        const payload = { username: body.username };
        message = authenticator.sign(payload);
      }
      response.status(mongoResponse.statusCode)
        .send(message);
    })
    .catch((error) => response.status(500).send(error.message));
});

/**
 *  Course Creation
 */
app.put("/course", (request, response) => {
  const logTag = "COURSE";
  logger.info(`[ ${logTag} ] course creation`);
  const courseCreate = (token, name, sources, description, shortDescription, wish) => {
    authenticator.verify(token)
      .then((payload) => {
        logger.info(`[ ${logTag} ] token verified ${wish}`);
        const action = "COURSE_CREATE";
        const username = payload.username;
        const riakData = {
          action: action,
          username: username
        };
        handler.sendMessage("riak", JSON.stringify(riakData));

        const uuid = uuidv4();
        const mongoData = {
          action: action,
          author: username,
          uuid: uuid,
          name: name,
          sources: sources,
          description: description,
          shortDescription: shortDescription,
          wish: wish
        };
        handler.sendMessage("mongo", JSON.stringify(mongoData));
        uuidMap.set(uuid, response);
        // Note: Mongo needs to process this and verify that it is not a duplicate.
      })
      .catch((error) => onTokenVerificationError(logTag, error, response));
  }

  courseVerify(request, response, courseCreate);
});

/**
 *  Course Read Pagination
 */
app.get("/course", (request, response) => {
  const logTag = "COURSE";
  const page = request.query.page || 0;
  const perPage = request.query.perPage || 10;
  const search = request.query.search;

  logger.info(`[ ${logTag} ] getting courses on page ${page} limit ${perPage}`);

  const riakData = {
    action: "COURSE_FETCH",
    id: "ALL"
  };
  handler.sendMessage("riak", JSON.stringify(riakData));

  let uri = `${MONGO_HOST}/course?page=${page}&perPage=${perPage}`;
  if (search) {
    uri = `${uri}&search=${search}`;
  }

  uri = encodeURI(uri);
  const options = {
    method: "GET",
    uri: uri,
    json: true
  };
  rp(options)
    .then((mongoResponse) => {
      logger.info(`[ ${logTag} ] mongo responded with ${JSON.stringify(mongoResponse)}`);
      let message = mongoResponse;
      response.status(mongoResponse.statusCode)
        .send(mongoResponse.message);
    })
    .catch((error) => {
      logger.error(`[ ${logTag} ] ${error.message}`);
      response.status(500).send({message: error.message})
    });
})

/**
 *  Course Read
 */
app.get("/course/:id", (request, response) => {
  const logTag = "COURSE";
  const courseId = request.params.id;
  logger.info(`[ ${logTag} ] fetching course ${courseId}`);

  const riakData = {
    action: "COURSE_FETCH",
    id: courseId
  };
  handler.sendMessage("riak", JSON.stringify(riakData));

  const uri = encodeURI(`${MONGO_HOST}/course/${courseId}`);
  const options = {
    method: "GET",
    uri: uri,
    json: true
  };
  rp(options)
    .then((mongoResponse) => {
      logger.info(`[ ${logTag} ] mongo responded with ${JSON.stringify(mongoResponse)}`);
      let message = mongoResponse;
      response.status(mongoResponse.statusCode)
        .send(mongoResponse.message);
    })
    .catch((error) => {
      logger.error(`[ ${logTag} ] ${error.message}`);
      response.status(500).send({message: error.message})
    });
});

/**
 *  Course Update
 */
app.post("/course/:id", (request, response) => {
  const logTag = "COURSE";
  const courseId = request.params.id;
  logger.info(`[ ${logTag} ] course ${courseId} update`);
  const courseUpdate = (token, name, sources, description, shortDescription) => {
    authenticator.verify(token)
      .then((payload) => {
        logger.info(`[ ${logTag} ] token verified`);
        const action = "COURSE_UPDATE";
        const riakData = {
          action: action,
          id: courseId
        };
        handler.sendMessage("riak", JSON.stringify(riakData));

        const mongoData = {
          action: action,
          courseId: courseId,
          name: name,
          sources: sources,
          description: description,
          shortDescription: shortDescription
        };
        handler.sendMessage("mongo", JSON.stringify(mongoData));
        response.status(202)
          .send("Course update has been queued for processing");
      })
      .catch((error) => onTokenVerificationError(logTag, error, response));
  }
  courseVerify(request, response, courseUpdate);
});

/**
 *  Course Delete
 */
app.delete("/course/:id", (request, response) => {
  const token = request.get("Authorization");
  const courseId = request.params.id;

  authenticator.verify(token)
    .then((payload) => {
      const action = "COURSE_DELETE";
      const username = payload.username;
      const riakData = {
        action: action,
        username: username
      };
      handler.sendMessage("riak", JSON.stringify(riakData));

      const mongoData = {
        action: action,
        courseId: courseId
      };
      handler.sendMessage("mongo", JSON.stringify(mongoData));
      response.status(202).send("Course has been queued for deletion.");
    })
    .catch((error) => onTokenVerificationError(logTag, error, response));
});

/**
 *  Verify the course request.
 *  If invalid, respond with 400 with helper message.
 *  If valid, call the onSuccess callback.
 *  format: onSuccess(token, name, sources, description, shortDescription)
 */
const courseVerify = (request, response, onSuccess) => {
  const token = request.get("Authorization");

  const body = request.body;
  const name = body.name;
  const sources = body.sources;
  const description = body.description;
  const shortDescription = body.shortDescription || "";
  const wish = body.wish || "";

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

  onSuccess(token, name, sources, description, shortDescription, wish);
}

/**
 *  Wish Create
 */
app.put("/wish", (request, response) => {
  const logTag = "WISH";
  logger.info(`[ ${logTag} ] wish creation`);

  const createWish = (token, name, details) => {
    authenticator.verify(token)
      .then((payload) => {
        logger.info(`[ ${logTag} ] token verified`);
        const username = payload.username
        const action = "WISH_CREATE";
        const riakData = {
          action: action,
          username: username
        };
        handler.sendMessage("riak", JSON.stringify(riakData));

        const uuid = uuidv4();
        const mongoData = {
          action: action,
          uuid: uuid,
          name: name,
          details: details,
          wisher: username
        };
        handler.sendMessage("mongo", JSON.stringify(mongoData));
        uuidMap.set(uuid, response);
      })
      .catch((error) => onTokenVerificationError(logTag, error, response));
  };

  wishVerify(request, response, createWish);
});

/**
 *  Wish Read Pagination
 */
app.get("/wish", (request, response) => {
  const page = request.query.page || 0;
  const perPage = request.query.perPage || 10;
  const search = request.query.search;
  const logTag = "WISH";

  logger.info(`[ ${logTag} ] getting wish on page ${page} with limit ${perPage}`);

  const riakData = {
    action: "WISH_FETCH",
    id: "ALL"
  };
  handler.sendMessage("riak", JSON.stringify(riakData));

  let uri = `${MONGO_HOST}/wish?page=${page}&perPage=${perPage}`;
  if (search) {
    uri = `${uri}&search=${search}`;
  }

  uri = encodeURI(uri);
  const options = {
    method: "GET",
    uri: uri,
    json: true
  };
  rp(options)
    .then((mongoResponse) => {
      logger.info(`[ ${logTag} ] mongo responded with ${JSON.stringify(mongoResponse)}`);
      let message = mongoResponse;
      response.status(mongoResponse.statusCode)
        .send(mongoResponse.message);
    })
    .catch((error) => {
      logger.error(`[ ${logTag} ] ${error.message}`);
      response.status(500).send({message: error.message})
    });
});

/**
 *  Wish Read
 */
app.get("/wish/:id", (request, response) => {
  const logTag = "WISH"
  const wishId = request.params.id;
  logger.info(`[ ${logTag} ] wish ${wishId} fetch`);

  const riakData = {
    action: "WISH_FETCH",
    id: wishId
  };
  handler.sendMessage("riak", JSON.stringify(riakData));

  const uri = encodeURI(`${MONGO_HOST}/wish/${wishId}`);
  const options = {
    method: "GET",
    uri: uri,
    json: true
  };
  rp(options)
    .then((mongoResponse) => {
      logger.info(`[ ${logTag} ] mongo responded with ${JSON.stringify(mongoResponse)}`);
      let message = mongoResponse;
      response.status(mongoResponse.statusCode)
        .send(mongoResponse.message);
    })
    .catch((error) => {
      logger.error(`[ ${logTag} ] ${error.message}`);
      response.status(500).send({message: error.message})
    });
});

/**
 *  Wish Update
 */
app.post("/wish/:id", (request, response) => {
  const logTag = "WISH"
  const wishId = request.params.id;
  logger.info(`[ ${logTag} ] wish ${wishId} update`);

  const updateWish = (token, name, details) => {
    authenticator.verify(token)
      .then((payload) => {
        const action = "WISH_UPDATE";
        const riakData = {
          action: action,
          id: wishId
        };
        handler.sendMessage("riak", JSON.stringify(riakData));

        const mongoData = {
          action: action,
          wishId: wishId,
          name: name,
          details: details,
        };
        handler.sendMessage("mongo", JSON.stringify(mongoData));
        response.status(202).send("Wish update has been queued for processing.");
      })
      .catch((error) => onTokenVerificationError(logTag, error, response));
  }

  wishVerify(request, response, updateWish);
});

/**
 *  Wish Delete
 */
app.delete("/wish/:id", (request, response) => {
  const token = request.get("Authorization");
  const wishId = request.params.id;
  const logTag = "WISH_DELETE"

  authenticator.verify(token)
    .then((payload) => {
      const action = "WISH_DELETE";
      const username = payload.username;
      const riakData = {
        action: action,
        username: username
      };
      handler.sendMessage("riak", JSON.stringify(riakData));

      const mongoData = {
        action: action,
        wishId: wishId
      };
      handler.sendMessage("mongo", JSON.stringify(mongoData));
      response.status(202).send("Wish has been queued for deletion.");
    })
    .catch((error) => onTokenVerificationError(logTag, error, response));
});

/**
 *  Verify Wish request body.
 *  If invalid, 400 with a help message will be sent.
 *  If valid, onSuccess will be called with (token, name, details)
 */
const wishVerify = (request, response, onSuccess) => {
  const token = request.get("Authorization");

  const body = request.body;
  const name = body.name;
  const details = body.details;

  if (!name || !details) {
    response.status(400)
      .send("A Wish requires a name and details");
    return;
  }

  onSuccess(token, name, details);
}

/**
 *  Handle token verification error.
 */
const onTokenVerificationError = (logTag, error, response) => {
  logger.error(`[ ${logTag} ] invalid token`);
  response.status(401)
    .json({message: error.message});
}

/**
 *  Stats on user logins from given ip.
 */
app.get("/stats/login", (request, response) => {
  const token = request.get("Authorization");
  const logTag = "STATS"
  const ip = request.ip;
  logger.info(`[ ${logTag} ] fetching stats for ip ${ip}`);

  authenticator.verify(token)
    .then((payload) => {
      const uri = encodeURI(`${RIAK_HOST}/login/${ip}`);
      const options = {
        method: "GET",
        uri: uri,
        json: true
      };

      rp(options)
        .then((riakResponse) => {
          logger.info(`[ ${logTag} ] riak responded with ${JSON.stringify(riakResponse)}`);
          if (riakResponse.isNotFound) {
            response.status(404)
              .send(`there are no login data for this ip: ${ip}`);
            return;
          }
          response.status(200)
            .send({attempts: riakResponse.map.counters});
        })
        .catch((error) => {
          logger.error(`[ ${logTag} ] ${error.message}`);
          response.status(500)
            .send({message: error.message});
        });
    })
    .catch((error) => onTokenVerificationError(logTag, error, response));
});

/**
 *  Stats on registration attempts given an IP.
 */
app.get("/stats/registration", (request, response) => {
  const token = request.get("Authorization");
  const ip = request.ip;
  const uri = encodeURI(`${RIAK_HOST}/registration/${ip}`);
  fetchCounters("REGISTRATION", ip, uri, token, response);
});

/**
 *  Stats on course creation from given username.
 */
app.get("/stats/course/create/:username", (request, response) => {
  const token = request.get("Authorization");
  const username = request.params.username;
  const uri = encodeURI(`${RIAK_HOST}/course/create/${username}`);
  fetchCounters("COURSE_CREATE", username, uri, token, response);
});

/**
 *  Stats on course fetch from given courseId.
 */
app.get("/stats/course/fetch/:courseId", (request, response) => {
  const token = request.get("Authorization");
  const courseId = request.params.courseId;
  const uri = encodeURI(`${RIAK_HOST}/course/fetch/${courseId}`);
  fetchCounters("COURSE_FETCH", courseId, uri, token, response);
});

/**
 *  Stats on course fetch on all courses.
 */
app.get("/stats/course/fetch", (request, response) => {
  const token = request.get("Authorization");
  const courseId = "ALL";
  const uri = encodeURI(`${RIAK_HOST}/course/fetch/${courseId}`);
  fetchCounters("COURSE_FETCH", courseId, uri, token, response);
});

/**
 *  Stats on course update from given courseId.
 */
app.get("/stats/course/update/:courseId", (request, response) => {
  const token = request.get("Authorization");
  const courseId = request.params.courseId;
  const uri = encodeURI(`${RIAK_HOST}/course/fetch/${courseId}`);
  fetchCounters("COURSE_FETCH", courseId, uri, token, response);
});

/**
 *  Stats on course deletion from given username.
 */
app.get("/stats/course/delete/:username", (request, response) => {
  const token = request.get("Authorization");
  const username = request.params.username;
  const uri = encodeURI(`${RIAK_HOST}/course/delete/${username}`);
  fetchCounters("COURSE_DELETE", username, uri, token, response);
});

/**
 *  Stats on wish creation from given username.
 */
app.get("/stats/wish/create/:username", (request, response) => {
  const token = request.get("Authorization");
  const username = request.params.username;
  const uri = encodeURI(`${RIAK_HOST}/wish/create/${username}`);
  fetchCounters("COURSE_CREATE", username, uri, token, response);
});

/**
 *  Stats on wish fetch from given wishId.
 */
app.get("/stats/wish/fetch/:wishId", (request, response) => {
  const token = request.get("Authorization");
  const wishId = request.params.wishId;
  const uri = encodeURI(`${RIAK_HOST}/wish/fetch/${wishId}`);
  fetchCounters("COURSE_FETCH", wishId, uri, token, response);
});

/**
 *  Stats on wish fetch on all wishes.
 */
app.get("/stats/wish/fetch", (request, response) => {
  const token = request.get("Authorization");
  const wishId = "ALL";
  const uri = encodeURI(`${RIAK_HOST}/wish/fetch/${wishId}`);
  fetchCounters("COURSE_FETCH", wishId, uri, token, response);
});

/**
 *  Stats on wish update from given wishId.
 */
app.get("/stats/wish/update/:wishId", (request, response) => {
  const token = request.get("Authorization");
  const wishId = request.params.wishId;
  const uri = encodeURI(`${RIAK_HOST}/wish/fetch/${wishId}`);
  fetchCounters("WISH_FETCH", wishId, uri, token, response);
});

/**
 *  Stats on wish deletion from given username.
 */
app.get("/stats/wish/delete/:username", (request, response) => {
  const token = request.get("Authorization");
  const username = request.params.username;
  const uri = encodeURI(`${RIAK_HOST}/wish/delete/${username}`);
  fetchCounters("WISH_DELETE", username, uri, token, response);
});

/**
 *  FetchCounter helper method
 */
const fetchCounters = (type, param, uri, token, response) => {
  authenticator.verify(token)
    .then((payload) => {
      const logTag = "STATS"
      logger.info(`[ ${logTag} ] fetching stats for ${type} ${param}`);
      const options = {
        method: "GET",
        uri: uri,
        json: true
      };
      rp(options)
      .then((riakResponse) => {
        logger.info(`[ ${logTag} ] riak responded with ${JSON.stringify(riakResponse)}`);
        if (riakResponse.isNotFound) {
          response.status(404)
            .send({message: `there are no ${type} stats for: ${param}`});
          return;
        }
        response.status(200)
          .send({count: riakResponse.counterValue});
      })
      .catch((error) => {
        logger.error(`[ ${logTag} ] ${error.message}`);
        response.status(500)
          .send({message: error.message})
      });
    })
    .catch((error) => onTokenVerificationError(logTag, error, response));
};

/**
 *  Handle synchronous responses.
 */
app.post("/respond", (request, response) => {
  const logTag = "RESPOND";
  logger.info("[ ${logTag} ] respond to user");
  const body = request.body;
  const uuid = body.uuid;
  const action = body.action;

  logger.info(`[ ${logTag} ] ${JSON.stringify(body)}`);

  const initResponse = uuidMap.get(uuid);
  if (initResponse) {
    switch (action) {
      case "REGISTRATION":
        logger.info(`[ ${logTag} ] responding to registration`);
        registrationResponder.respond(initResponse, body);
        break;
      case "COURSE_CREATE":
        logger.info(`[ ${logTag} ] responding to course creation`);
        courseCreationResponder.respond(initResponse, body);
        break;
      case "WISH_CREATE":
        logger.info(`[ ${logTag} ] responding to wish creation`);
        wishCreationResponder.respond(initResponse, body);
        break;
      default:
        logger.warn(`[ ${logTag} ] Unrecognized action ${action}`);
        initResponse.status(500).send("Unexpected response action");
        break;
    }
    uuidMap.delete(uuid);
  }

  logger.info(`[ ${logTag} ] responding to handler with 200`);
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
      logger.info(`[ INIT ] Webserver is LIVE. ${PORT}`);
      logger.info(`[ INIT ] Rabbitmq Endpoint: ${process.env.RABBITMQ_HOST}`);
    }
  });
}
