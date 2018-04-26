class RegistrationResponder {
  constructor(authenticator) {
    this.authenticator = authenticator;
  }

  respond(response, body) {
    switch (body.statusCode) {
      case (201): // success
        const payload = {
          username: body.username
        };
        const token = this.authenticator.sign(payload);
        response.status(body.statusCode)
          .send(token);
        break;
      case (100): // processing
      case (500): // failed to insert
      case (409): // duplicate username
        response.status(body.statusCode)
          .send(body.message);
        break;
      default:
        response.status(body.statusCode)
          .send(`Unhandled registration ${body}`);
        break;
    }

  }
}

module.exports = RegistrationResponder;
