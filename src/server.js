#!/usr/bin/env node
'use strict';

process.env.UV_THREADPOOL_SIZE =
    Math.ceil(Math.max(4, require('os').cpus().length * 1.5));

const fs = require('fs');
const path = require('path');

const clone = require('clone');
const cors = require('cors');
const enableShutdown = require('http-shutdown');
const express = require('express');
const handlebars = require('handlebars');
const mercator = new (require('@mapbox/sphericalmercator'))();
const morgan = require('morgan');

const packageJson = require('../package');
const serve_font = require('./serve_font');
const serve_style = require('./serve_style');
const serve_data = require('./serve_data');
const utils = require('./utils');

let serve_rendered = null;
const isLight = packageJson.name.slice(-6) === '-light';
if (!isLight) {
  // do not require `serve_rendered` in the light package
  serve_rendered = require('./serve_rendered');
}

function start(opts) {
  console.log('Starting server');

  const app = express().disable('x-powered-by'),
    serving = {
      styles: {},
      rendered: {},
      data: {},
      fonts: {}
    };

  app.enable('trust proxy');

  if (process.env.NODE_ENV !== 'test') {
    const defaultLogFormat = process.env.NODE_ENV === 'production' ? 'tiny' : 'dev';
    const logFormat = opts.logFormat || defaultLogFormat;
    app.use(morgan(logFormat, {
      stream: opts.logFile ? fs.createWriteStream(opts.logFile, { flags: 'a' }) : process.stdout,
      skip: (req, res) => opts.silent && (res.statusCode === 200 || res.statusCode === 304)
    }));
  }

  let config = opts.config || null;
  let configPath = null;
  if (opts.configPath) {
    configPath = path.resolve(opts.configPath);
    try {
      config = clone(require(configPath));
    } catch (e) {
      console.log('ERROR: Config file not found or invalid!');
      console.log('       See README.md for instructions and sample data.');
      process.exit(1);
    }
  }
  if (!config) {
    console.log('ERROR: No config file not specified!');
    process.exit(1);
  }

  const options = config.options || {};
  const paths = options.paths || {};
  options.paths = paths;
  paths.root = path.resolve(
    configPath ? path.dirname(configPath) : process.cwd(),
    paths.root || '');
  paths.styles = path.resolve(paths.root, paths.styles || '');
  paths.fonts = path.resolve(paths.root, paths.fonts || '');
  paths.sprites = path.resolve(paths.root, paths.sprites || '');
  paths.mbtiles = path.resolve(paths.root, paths.mbtiles || '');

  const startupPromises = [];

  const checkPath = type => {
    if (!fs.existsSync(paths[type])) {
      console.error(`The specified path for "${type}" does not exist (${paths[type]}).`);
      process.exit(1);
    }
  };
  checkPath('styles');
  checkPath('fonts');
  checkPath('sprites');
  checkPath('mbtiles');

  if (options.dataDecorator) {
    try {
      options.dataDecoratorFunc = require(path.resolve(paths.root, options.dataDecorator));
    } catch (e) {}
  }

  const data = clone(config.data || {});

  if (opts.cors) {
    app.use(cors());
  }

  for (const id of Object.keys(config.styles || {})) {
    const item = config.styles[id];
    if (!item.style || item.style.length === 0) {
      console.log(`Missing "style" property for ${id}`);
      continue;
    }

    if (item.serve_data !== false) {
      startupPromises.push(serve_style(options, serving.styles, item, id, opts.publicUrl,
        (mbtiles, fromData) => {
          let dataItemId;
          for (const id of Object.keys(data)) {
            if (fromData) {
              if (id === mbtiles) {
                dataItemId = id;
              }
            } else {
              if (data[id].mbtiles === mbtiles) {
                dataItemId = id;
              }
            }
          }
          if (dataItemId) { // mbtiles exist in the data config
            return dataItemId;
          } else if (fromData) {
            console.log(`ERROR: data "${mbtiles}" not found!`);
            process.exit(1);
          } else {
            let id = mbtiles.substr(0, mbtiles.lastIndexOf('.')) || mbtiles;
            while (data[id]) id += '_';
            data[id] = {
              'mbtiles': mbtiles
            };
            return id;
          }
        }, font => {
          serving.fonts[font] = true;
        }).then(sub => {
          app.use('/styles/', sub);
        }));
    }
    if (item.serve_rendered !== false) {
      if (serve_rendered) {
        startupPromises.push(
          serve_rendered(options, serving.rendered, item, id, opts.publicUrl,
            mbtiles => {
              let mbtilesFile;
              for (const id of Object.keys(data)) {
                if (id === mbtiles) {
                  mbtilesFile = data[id].mbtiles;
                }
              }
              return mbtilesFile;
            }
          ).then(sub => {
            app.use('/styles/', sub);
          })
        );
      } else {
        item.serve_rendered = false;
      }
    }
  }

  startupPromises.push(
    serve_font(options, serving.fonts).then(sub => {
      app.use('/', sub);
    })
  );

  for (const id of Object.keys(data)) {
    const item = data[id];
    if (!item.mbtiles || item.mbtiles.length === 0) {
      console.log(`Missing "mbtiles" property for ${id}`);
      continue;
    }

    startupPromises.push(
      serve_data(options, serving.data, item, id, serving.styles, opts.publicUrl).then(sub => {
        app.use('/data/', sub);
      })
    );
  }

  app.get('/styles.json', (req, res, next) => {
    const result = [];
    const query = req.query.key ? (`?key=${req.query.key}`) : '';
    for (const id of Object.keys(serving.styles)) {
      const styleJSON = serving.styles[id];
      result.push({
        version: styleJSON.version,
        name: styleJSON.name,
        id: id,
        url: `${utils.getPublicUrl(opts.publicUrl, req)}styles/${id}/style.json${query}`
      });
    }
    res.send(result);
  });

  const addTileJSONs = (arr, req, type) => {
    for (const id of Object.keys(serving[type])) {
      const info = clone(serving[type][id]);
      let path = '';
      if (type === 'rendered') {
        path = `styles/${id}`;
      } else {
        path = `${type}/${id}`;
      }
      info.tiles = utils.getTileUrls(req, info.tiles, path, info.format, opts.publicUrl, {
        'pbf': options.pbfAlias
      });
      arr.push(info);
    }
    return arr;
  };

  app.get('/rendered.json', (req, res, next) => {
    res.send(addTileJSONs([], req, 'rendered'));
  });
  app.get('/data.json', (req, res, next) => {
    res.send(addTileJSONs([], req, 'data'));
  });
  app.get('/index.json', (req, res, next) => {
    res.send(addTileJSONs(addTileJSONs([], req, 'rendered'), req, 'data'));
  });

  //------------------------------------
  // serve web presentations
  app.use('/', express.static(path.join(__dirname, '../public/resources')));

  const templates = path.join(__dirname, '../public/templates');
  const serveTemplate = (urlPath, template, dataGetter) => {
    let templateFile = `${templates}/${template}.tmpl`;
    if (template === 'index') {
      if (options.frontPage === false) {
        return;
      } else if (options.frontPage &&
        options.frontPage.constructor === String) {
        templateFile = path.resolve(paths.root, options.frontPage);
      }
    }
    startupPromises.push(new Promise((resolve, reject) => {
      fs.readFile(templateFile, (err, content) => {
        if (err) {
          err = new Error(`Template not found: ${err.message}`);
          reject(err);
          return;
        }
        const compiled = handlebars.compile(content.toString());

        app.use(urlPath, (req, res, next) => {
          let data = {};
          if (dataGetter) {
            data = dataGetter(req);
            if (!data) {
              return res.status(404).send('Not found');
            }
          }
          data['server_version'] = `${packageJson.name} v${packageJson.version}`;
          data['public_url'] = opts.publicUrl || '/';
          data['is_light'] = isLight;
          data['key_query_part'] =
            req.query.key ? `key=${req.query.key}&amp;` : '';
          data['key_query'] = req.query.key ? `?key=${req.query.key}` : '';
          if (template === 'wmts') res.set('Content-Type', 'text/xml');
          return res.status(200).send(compiled(data));
        });
        resolve();
      });
    }));
  };

  serveTemplate('/$', 'index', req => {
    const styles = clone(config.styles || {});
    for (const id of Object.keys(styles)) {
      const style = styles[id];
      style.name = (serving.styles[id] || serving.rendered[id] || {}).name;
      style.serving_data = serving.styles[id];
      style.serving_rendered = serving.rendered[id];
      if (style.serving_rendered) {
        const center = style.serving_rendered.center;
        if (center) {
          style.viewer_hash = `#${center[2]}/${center[1].toFixed(5)}/${center[0].toFixed(5)}`;

          const centerPx = mercator.px([center[0], center[1]], center[2]);
          style.thumbnail = `${center[2]}/${Math.floor(centerPx[0] / 256)}/${Math.floor(centerPx[1] / 256)}.png`;
        }

        style.xyz_link = utils.getTileUrls(
          req, style.serving_rendered.tiles,
          `styles/${id}`, style.serving_rendered.format, opts.publicUrl)[0];
      }
    }
    const data = clone(serving.data || {});
    for (const id of Object.keys(data)) {
      const data_ = data[id];
      const center = data_.center;
      if (center) {
        data_.viewer_hash = `#${center[2]}/${center[1].toFixed(5)}/${center[0].toFixed(5)}`;
      }
      data_.is_vector = data_.format === 'pbf';
      if (!data_.is_vector) {
        if (center) {
          const centerPx = mercator.px([center[0], center[1]], center[2]);
          data_.thumbnail = `${center[2]}/${Math.floor(centerPx[0] / 256)}/${Math.floor(centerPx[1] / 256)}.${data_.format}`;
        }

        data_.xyz_link = utils.getTileUrls(
          req, data_.tiles, `data/${id}`, data_.format, opts.publicUrl, {
            'pbf': options.pbfAlias
          })[0];
      }
      if (data_.filesize) {
        let suffix = 'kB';
        let size = parseInt(data_.filesize, 10) / 1024;
        if (size > 1024) {
          suffix = 'MB';
          size /= 1024;
        }
        if (size > 1024) {
          suffix = 'GB';
          size /= 1024;
        }
        data_.formatted_filesize = `${size.toFixed(2)} ${suffix}`;
      }
    }
    return {
      styles: Object.keys(styles).length ? styles : null,
      data: Object.keys(data).length ? data : null
    };
  });

  serveTemplate('/styles/:id/$', 'viewer', req => {
    const id = req.params.id;
    const style = clone((config.styles || {})[id]);
    if (!style) {
      return null;
    }
    style.id = id;
    style.name = (serving.styles[id] || serving.rendered[id]).name;
    style.serving_data = serving.styles[id];
    style.serving_rendered = serving.rendered[id];
    return style;
  });

  /*
  app.use('/rendered/:id/$', function(req, res, next) {
    return res.redirect(301, '/styles/' + req.params.id + '/');
  });
  */
  serveTemplate('/styles/:id/wmts.xml', 'wmts', req => {
    const id = req.params.id;
    const wmts = clone((config.styles || {})[id]);
    if (!wmts) {
      return null;
    }
    if (wmts.hasOwnProperty("serve_rendered") && !wmts.serve_rendered) {
      return null;
    }
    wmts.id = id;
    wmts.name = (serving.styles[id] || serving.rendered[id]).name;
    wmts.baseUrl = `${req.get('X-Forwarded-Protocol') ? req.get('X-Forwarded-Protocol') : req.protocol}://${req.get('host')}`;
    return wmts;
  });

  serveTemplate('/data/:id/$', 'data', req => {
    const id = req.params.id;
    const data = clone(serving.data[id]);
    if (!data) {
      return null;
    }
    data.id = id;
    data.is_vector = data.format === 'pbf';
    return data;
  });

  let startupComplete = false;
  const startupPromise = Promise.all(startupPromises).then(() => {
    console.log('Startup complete');
    startupComplete = true;
  });
  app.get('/health', (req, res, next) => {
    if (startupComplete) {
      return res.status(200).send('OK');
    } else {
      return res.status(503).send('Starting');
    }
  });

  const server = app.listen(process.env.PORT || opts.port, process.env.BIND || opts.bind, function () {
    let address = this.address().address;
    if (address.indexOf('::') === 0) {
      address = `[${address}]`; // literal IPv6 address
    }
    console.log(`Listening at http://${address}:${this.address().port}/`);
  });

  // add server.shutdown() to gracefully stop serving
  enableShutdown(server);

  return {
    app: app,
    server: server,
    startupPromise: startupPromise
  };
}

module.exports = opts => {
  const running = start(opts);

  running.startupPromise.catch(err => {
    console.error(err.message);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    process.exit();
  });

  process.on('SIGHUP', () => {
    console.log('Stopping server and reloading config');

    running.server.shutdown(() => {
      for (const key in require.cache) {
        delete require.cache[key];
      }

      const restarted = start(opts);
      running.server = restarted.server;
      running.app = restarted.app;
    });
  });

  return running;
};
