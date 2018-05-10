const amqp = require("amqplib");
const dotenv = require("dotenv");
dotenv.config();

class RabbitHandler {
  constructor(host, logger) {
    this.host = host;
    this.logger = logger;
  }

  sendMessage(routingKey, message) {
    amqp.connect(this.host)
      .then((connection) => {
        connection.createChannel()
          .then((channel) => {
            const exchange = "coursebook";
            channel.assertExchange(exchange, "direct");
            channel.publish(exchange, routingKey, Buffer.from(message));
            this.logger.info(`[ ${routingKey} ] sent message '${message}'`);
          })
          .catch((error) => {
            this.logger.error(`[ ${routingKey} ] unable to create channel ${this.host}: ${error.message}`);
          });
      })
      .catch((error) => {
        this.logger.error(`[ ${routingKey} ] unable to create connection: ${error.message}`);
      })
  }
}

module.exports = RabbitHandler;
