const jwt = require("jsonwebtoken");

class Authenticator {
  constructor(secret) {
    this.secret = secret;
  }

  sign(payload) {
    const options = {
      expiresIn: "2 days",
      issuer: "course-book-auth-server"
    };
    return jwt.sign(payload, this.secret, options);
  }

  verify(token) {
    const options = {
      algorithms: ["HS256"],
      issuer: "course-book-auth-server",
      maxAge: "2 days"
    }
    return new Promise((resolve, reject) => {
      jwt.verify(token, this.secret, options, (error, decoded) => {
        if (error) {
          reject(error.message);
        } else {
          resolve(decoded);
        }
      });
    });
  }
}

module.exports = Authenticator;
