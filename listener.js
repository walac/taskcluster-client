var events    = require('events');
var util      = require('util');
var amqplib   = require('amqplib');
var Promise   = require('promise');
var debug     = require('debug')('taskcluster-client:listener');
var _         = require('lodash');
var assert    = require('assert');
var slugid    = require('slugid');

/** Create new Listener */
var Listener = function() {
  this._connected = false;
  this._bindings = [];
  this._options = _.defaults(options || {}, {
    prefetch:               5,
    connectionString:       undefined,
    queueName:              undefined,
    maxLength:              undefined

    //
    //    no queueName: exclusive, autodelete, durable: false
    //    queueName:    durable: true, autoDelete: false, exclusive: false
  });
};

// Inherit from events.EventEmitter
util.inherits(Listener, events.EventEmitter);

/**
 * Bind listener to exchange with routing key and optional routing key
 * reference used to parse routing keys.
 *
 * binding: {
 *   exchange:              '...',  // Exchange to bind
 *   routingKeyPattern:     '...',  // Routing key as string
 *   routingKeyReference:   {...}   // Reference used to parse routing keys
 * }
 *
 * if `routingKeyReference` is provided for the exchange from which messages
 * arrive the listener will parse the routing key and make it available as a
 * dictionary on the message.
 *
 * **Note,** the arguments for this method is easily constructed using an
 * instance of `Client`, see `createClient`.
 */
Listener.prototype.bind = function(binding) {
  assert(binding.exchange,          "Can't bind to unspecified exchange!");
  assert(binding.routingKeyPattern, "routingKeyPattern is required!");
  this._bindings.push(binding);
  if(binding.connected) {
    return that._channel.bindQueue(
      that._queueName,
      binding.exchange,
      binding.routingKey
    );
  } else {
    return Promise.from(null);
  }
};

/** Connect, setup queue and binding to exchanges */
Listener.prototype.connect = function() {
  assert(!this._connected, "Can't connect when already connected");
  var that = this;

  // Create AMQP connection and channel
  var channelCreated = amqplib.connect(
    this._options.connectionString
  ).then(function(conn) {
    that._conn = conn;
    that._conn.on('error', function(err) {
      debug("Connection error in Listener: ", err.stack);
      that.emit('error', err);
    });
    return that._conn.createConfirmChannel();
  }).then(function(channel) {
    that._channel = channel;
    that._channel.on('error', function(err) {
      debug("Channel error in Listener: ", err.stack);
      that.emit('error', err);
    });
    return that._channel.prefetch(that._options.prefetch);
  });

  // Find queue name and decide if this is an exclusive queue
  this._queueName = this._options.queueName || slugid.v4();
  var exclusive = this._options.queueName != undefined;

  // Create queue
  var queueCreated = channelCreated.then(function() {
    var opts = {
      exclusive:  exclusive,
      durable:    !exclusive,
      autoDelete: exclusive,
    };
    // Set max length if provided
    if (that._options.maxLength) {
      opts.maxLength =  that._options.maxLength;
    }
    return that._channel.assertQueue(that._queueName, opts);
  });

  // Create bindings
  var bindingsCreated = queueCreated.then(function() {
    return Promise.all(that._bindings.map(function(binding) {
      return that._channel.bindQueue(
        that._queueName,
        binding.exchange,
        binding.routingKey
      );
    }));
  });

  // Begin consumption
  return bindingsCreated.then(function() {
    return that._channel.consume(that._queueName, function(msg) {
      that._handle(msg);
    });
  }).then(function(result) {
    that._consumerTag = result.consumerTag;
    that._connected = true;
  });
};

/** Pause consumption of messages */
Listener.prototype.pause = function() {
  if (!this._connected) {
    debug("WARNING: Paused listener instance was wasn't connected yet");
    return;
  }
  assert(this._connected, "Can't pause when not connected");
  return this._channel(that._consumerTag);
};

/** Connect or resume consumption of message */
Listener.prototype.resume = function() {
  if(!this._connected) {
    return this.connect();
  } else {
    var that = this;
    return that._channel.consume(that._queueName, function(msg) {
      that._handle(msg);
    }).then(function(result) {
      that._consumerTag = result.consumerTag;
    });
  }
};

/** Handle message*/
Listener.prototype._handle = function(msg) {
  var that = this;
  // Construct message
  var message = {
    payload:      JSON.parse(msg.content.toString('utf8')),
    exchange:     msg.fields.exchange,
    routingKey:   msg.fields.routingKey,
    redelivered:  msg.fields.redelivered
  };

  // Find routing key reference, if any is available to us
  var routingKeyReference = null;
  this._bindings.forEach(function(binding) {
    if(binding.exchange === message.exchange && binding.routingKeyReference) {
      routingKeyReference = binding.routingKeyReference;
    }
  });

  // If we have a routing key reference we can parse the routing key
  if (routingKeyReference) {
    try {
      var routing = {};
      var keys = message.routingKey.split('.');
      // first handle non-multi keys from the beginning
      for(var i = 0; i < routingKeyReference.length; i++) {
        var ref = routingKeyReference[i];
        if (ref.multipleWords) {
          break;
        }
        routing[ref.name] = keys.shift();
      }
      // then handle non-multi keys from the end
      for(var j = routingKeyReference.length - 1; j > i; j--) {
        var ref = routingKeyReference[j];
        if (ref.multipleWords) {
          break;
        }
        routing[ref.name] = keys.pop();
      }
      // Check that we only have one multiWord routing key
      assert(i == j, "i != j really shouldn't be the case");
      routing[routingKeyReference[i].name] = keys.join('.');

      // Provide parsed routing key
      message.routing = routingKeyReference;
    }
    catch(err) {
      // Ideally we should rethrow the exception. But since it's not quite
      // possible to promise that `routing` (the parsed routing key) is
      // available... As you can subscribe without providing a routing
      // key reference.
      // In short people can assume this is present in most cases, and if they
      // assume this we get the error at a level where they can handle it.
      debug("Failed to parse routingKey: %s for %s with err: %s, as JSON: %j",
            message.routingKey, message.exchange, err, err, err.stack);
    }
  }

  // Process handlers
  Promise.all(this.listeners('message').map(function(handler) {
    return handler(message);
  })).then(function() {
    return that.channel.ack(msg);
  }).catch(function(err) {
    debug("Failed to process message %j from %s with error: %s, as JSON: %j",
          message, message.exchange, err, err, err.stack);
    if (message.redelivered) {
      debug("Nack (without requeueing) message %j from %s",
            message, message.exchange);
      return that.channel.nack(msg, false, false);
    } else {
      // Nack and requeue
      return that.channel.nack(msg, false, true);
    }
  }).catch(function() {
    debug("CRITICAL: Failed to nack message");
    that.emit('error', err);
  });
};

/** Close the listener */
Listener.prototype.close = function() {
  return this._conn.close();
};

// Export Listener
module.exports = Listener;

/*
options:
 {
    prefetch:   1,
    context:    {},
    amqpUrl:    '...'
    start:      true || false,
    maxLength:  undefined
 }

var eventHandler = new taskcluster.EventHandler(options);

eventHandler.configure(options);

var schedulerEvents = new taskcluster.SchedulerEvents({exchangePrefix: ...});
eventHandler.bind(schedulerEvents.taskGraphBlocked({
  taskId:
});

eventHandler.handle(function(message) {
  message.payload               // Message payload as JSON

  message.routing.taskId        // taskId part of routing key
  message.routing...
  message.routing.workerGroup
  message.routing.routing       // Tasks specific routing key

  message.routingKey            // Routing key as text

  message.exchange              // string queue/v1/exchangeId
                                // Can compare to
                                // schedulerEvents.taskGraphBlocked().exchange
  message.redelivered           // true, if delivered before
  return new Promise(...);
});

// if redelivered messages fails, then it's logged and the message is dropped

eventHandler.setup(options).then(function(listener) {
  listener.pause()
  listener.resume()
  listener.on('error', function() {crash});
  listener.terminate();
});


*/

/*
var listener = new taskcluster.Listener(options);

listener.bind(...);

listener.on('message', function(message) {...});

listener.connect().then(function() {
  listener.resume();
  listener.pause();
});

*/

