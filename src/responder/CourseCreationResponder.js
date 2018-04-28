class CourseCreationResponder {
  respond(response, body) {
    switch (body.statusCode) {
      case (201): // success
        response.status(body.statusCode)
          .send(body.message);
        break;
      case (100): // processing
      case (500): // failed to insert
      case (409): // duplicate course
        response.status(body.statusCode)
          .send(body.message);
        break;
      default:
        response.status(body.statusCode)
          .send(`Unhandled course creation ${body}`);
        break;
    }

  }
}

module.exports = CourseCreationResponder;
