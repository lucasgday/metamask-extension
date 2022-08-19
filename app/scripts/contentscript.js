import pump from 'pump';
import { WindowPostMessageStream } from '@metamask/post-message-stream';
import ObjectMultiplex from 'obj-multiplex';
import browser from 'webextension-polyfill';
import PortStream from 'extension-port-stream';
/** @todo uncomment Legacy Provider Support */
// import { obj as createThoughStream } from 'through2';

import { isManifestV3 } from '../../shared/modules/mv3.utils';
import shouldInjectProvider from '../../shared/modules/provider-injection';

// These require calls need to use require to be statically recognized by browserify
const fs = require('fs');
const path = require('path');

const inpageContent = fs.readFileSync(
  path.join(__dirname, '..', '..', 'dist', 'chrome', 'inpage.js'),
  'utf8',
);
const inpageSuffix = `//# sourceURL=${browser.runtime.getURL('inpage.js')}\n`;
const inpageBundle = inpageContent + inpageSuffix;

// contexts
const CONTENT_SCRIPT = 'metamask-contentscript';
const INPAGE = 'metamask-inpage';
const PHISHING_WARNING_PAGE = 'metamask-phishing-warning-page';

// stream channels
const PHISHING_SAFELIST = 'metamask-phishing-safelist';
const PROVIDER = 'metamask-provider';

// For more information about these legacy streams, see here:
// https://github.com/MetaMask/metamask-extension/issues/15491
// TODO:LegacyProvider: Delete
/** @todo uncomment Legacy Provider Support */
// const LEGACY_CONTENT_SCRIPT = 'contentscript';
// const LEGACY_INPAGE = 'inpage';
// const LEGACY_PROVIDER = 'provider';
const LEGACY_PUBLIC_CONFIG = 'publicConfig';

const WORKER_KEEP_ALIVE_MESSAGE = 'WORKER_KEEP_ALIVE_MESSAGE';

const phishingPageUrl = new URL(process.env.PHISHING_WARNING_PAGE_URL);

let extensionMux,
  extensionPort,
  extensionStream,
  pageMux,
  pageStream,
  phishingStream;

// legacyExtensionMux,
// legacyPageMux,
// legacyPageStream,

/**
 * Injects a script tag into the current document
 *
 * @param {string} content - Code to be executed in the current document
 */
function injectScript(content) {
  try {
    const container = document.head || document.documentElement;
    const scriptTag = document.createElement('script');
    scriptTag.setAttribute('async', 'false');
    scriptTag.textContent = content;
    container.insertBefore(scriptTag, container.children[0]);
    container.removeChild(scriptTag);
  } catch (error) {
    console.error('MetaMask: Provider injection failed.', error);
  }
}

/**
 * @todo support phishing stream when Service Worker restarts
 */
function setupPhishingStream() {
  // the transport-specific streams for communication between inpage and background
  const pagePhishingStream = new WindowPostMessageStream({
    name: CONTENT_SCRIPT,
    target: PHISHING_WARNING_PAGE,
  });
  const extensionPhishingPort = browser.runtime.connect({
    name: CONTENT_SCRIPT,
  });
  const extensionPhishingStream = new PortStream(extensionPhishingPort);

  // create and connect channel muxers
  // so we can handle the channels individually
  const pagePhishingMux = new ObjectMultiplex();
  pagePhishingMux.setMaxListeners(25);
  const extensionPhishingMux = new ObjectMultiplex();
  extensionPhishingMux.setMaxListeners(25);

  pump(pagePhishingMux, pagePhishingStream, pagePhishingMux, (err) =>
    logStreamDisconnectWarning('MetaMask Inpage Multiplex', err),
  );
  pump(
    extensionPhishingMux,
    extensionPhishingStream,
    extensionPhishingMux,
    (err) => {
      logStreamDisconnectWarning('MetaMask Background Multiplex', err);
      window.postMessage(
        {
          target: PHISHING_WARNING_PAGE, // the post-message-stream "target"
          data: {
            // this object gets passed to obj-multiplex
            name: PHISHING_SAFELIST, // the obj-multiplex channel name
            data: {
              jsonrpc: '2.0',
              method: 'METAMASK_STREAM_FAILURE',
            },
          },
        },
        window.location.origin,
      );
    },
  );

  // forward communication across inpage-background for these channels only
  forwardTrafficBetweenMuxes(
    PHISHING_SAFELIST,
    pagePhishingMux,
    extensionPhishingMux,
  );
}

/**
 * Creates and connects channel multiplexes to handle the channels individually
 */
const setupStreams = () => {
  console.log('setupStreams called');

  pageStream = new WindowPostMessageStream({
    name: CONTENT_SCRIPT,
    target: INPAGE,
  });

  pageMux = new ObjectMultiplex();
  pageMux.setMaxListeners(25);

  extensionMux = new ObjectMultiplex();
  extensionMux.setMaxListeners(25);
  extensionMux.ignoreStream(LEGACY_PUBLIC_CONFIG); // TODO:LegacyProvider: Delete

  pump(pageMux, pageStream, pageMux, (err) =>
    logStreamDisconnectWarning('MetaMask Inpage Multiplex', err),
  );

  pump(extensionMux, extensionStream, extensionMux, (err) => {
    logStreamDisconnectWarning('MetaMask Background Multiplex', err);
    notifyInpageOfStreamFailure();
  });

  /** forward communication across inpage-background for these channels only */
  forwardTrafficBetweenMuxes(PROVIDER, pageMux, extensionMux);

  /** connect "phishing" channel to warning system */
  phishingStream = extensionMux.createStream('phishing');
  phishingStream.once('data', redirectToPhishingWarning);
};

/**
 * Destroying the destination streams of the pump (should) destroy the streams before it
 *
 * @todo
 * - Remove text (should) above after confirming this works
 * - Answer questions:
 *   1. is it necessary to manually set allowHalfOpen to false?
 *      "If false then the stream will automatically end the writable side when the readable side ends"
 *   2 is it necessary to removeAllListeners if we're calling destroy?
 *
 * - is there an unpump method similar to unpipe?
 * @see {@link https://nodejs.org/dist/v18.0.0/docs/api/stream.html#duplex-and-transform-streams}
 * @see {@link https://github.com/mafintosh/pump#readme}
 */
const destroyPageStreams = () => {
  extensionMux.allowHalfOpen = false;
  extensionMux.removeAllListeners();
  extensionMux.destroy();

  pageMux.allowHalfOpen = false;
  pageMux.removeAllListeners();
  pageMux.destroy();

  pageStream.allowHalfOpen = false;
  pageStream.removeAllListeners();
  pageStream.destroy();

  /** @todo uncomment Legacy Provider Support */
  // legacyPageMux.allowHalfOpen = false;
  // legacyPageMux.removeAllListeners();
  // legacyPageMux.destroy();

  // legacyExtensionMux.allowHalfOpen = false;
  // legacyExtensionMux.removeAllListeners();
  // legacyExtensionMux.destroy();
};

/**
 * Resets the extension stream with new streams and attach event listeners to the extension port.
 */
const resetStreamAndListeners = () => {
  console.log('resetStreamAndListeners called');

  extensionPort.onDisconnect.removeListener(resetStreamAndListeners);

  /**
   * The message below will try to activate service worker
   * in MV3 is likely that reason of stream closing is service worker going in-active
   */
  browser.runtime.sendMessage({ name: WORKER_KEEP_ALIVE_MESSAGE });

  destroyPageStreams();

  extensionPort = browser.runtime.connect({ name: CONTENT_SCRIPT });
  extensionStream = new PortStream(extensionPort);

  setupStreams();

  /** @todo uncomment Legacy Provider Support */
  // setupLegacyStreams();

  extensionPort.onDisconnect.addListener(resetStreamAndListeners);
};

/**
 * Sets up two-way communication streams between the
 * browser extension and local per-page browser context.
 *
 * @todo LegacyProvider: Delete
 * @todo uncomment
 */
// function setupLegacyStreams() {
//   console.log('setupLegacyStreams called');

//   legacyPageStream = new WindowPostMessageStream({
//     name: LEGACY_CONTENT_SCRIPT,
//     target: LEGACY_INPAGE,
//   });

//   legacyPageMux = new ObjectMultiplex();
//   legacyPageMux.setMaxListeners(25);
//   legacyExtensionMux = new ObjectMultiplex();
//   legacyExtensionMux.setMaxListeners(25);

//   pump(legacyPageMux, legacyPageStream, legacyPageMux, (err) =>
//     logStreamDisconnectWarning('MetaMask Legacy Inpage Multiplex', err),
//   );
//   pump(
//     legacyExtensionMux,
//     extensionStream,
//     getNotificationTransformStream(),
//     legacyExtensionMux,
//     (err) => {
//       logStreamDisconnectWarning('MetaMask Background Legacy Multiplex', err);
//       notifyInpageOfStreamFailure();
//     },
//   );

//   forwardNamedTrafficBetweenMuxes(
//     LEGACY_PROVIDER,
//     PROVIDER,
//     legacyPageMux,
//     legacyExtensionMux,
//   );
//   forwardTrafficBetweenMuxes(
//     LEGACY_PUBLIC_CONFIG,
//     legacyPageMux,
//     legacyExtensionMux,
//   );
// }

/**
 * Sets up two-way communication streams between the
 * browser extension and local per-page browser context.
 */
const initStreams = () => {
  console.log('initStreams called');

  extensionPort = browser.runtime.connect({ name: CONTENT_SCRIPT });
  extensionStream = new PortStream(extensionPort);

  setupStreams();

  /** @todo uncomment Legacy Provider Support */
  // setupLegacyStreams();

  extensionPort.onDisconnect.addListener(resetStreamAndListeners);
};

function forwardTrafficBetweenMuxes(channelName, muxA, muxB) {
  const channelA = muxA.createStream(channelName);
  const channelB = muxB.createStream(channelName);
  pump(channelA, channelB, channelA, (error) =>
    console.debug(
      `MetaMask: Muxed traffic for channel "${channelName}" failed.`,
      error,
    ),
  );
}

// TODO:LegacyProvider: Delete
// function forwardNamedTrafficBetweenMuxes(
//   channelAName,
//   channelBName,
//   muxA,
//   muxB,
// ) {
//   const channelA = muxA.createStream(channelAName);
//   const channelB = muxB.createStream(channelBName);
//   pump(channelA, channelB, channelA, (error) =>
//     console.debug(
//       `MetaMask: Muxed traffic between channels "${channelAName}" and "${channelBName}" failed.`,
//       error,
//     ),
//   );
// }

// TODO:LegacyProvider: Delete
// function getNotificationTransformStream() {
//   return createThoughStream((chunk, _, cb) => {
//     if (chunk?.name === PROVIDER) {
//       if (chunk.data?.method === 'metamask_accountsChanged') {
//         chunk.data.method = 'wallet_accountsChanged';
//         chunk.data.result = chunk.data.params;
//         delete chunk.data.params;
//       }
//     }
//     cb(null, chunk);
//   });
// }

/**
 * Error handler for page to extension stream disconnections
 *
 * @param {string} remoteLabel - Remote stream name
 * @param {Error} error - Stream connection error
 */
function logStreamDisconnectWarning(remoteLabel, error) {
  console.debug(
    `MetaMask: Content script lost connection to "${remoteLabel}".`,
    error,
  );
}

/**
 * This function must ONLY be called in pump destruction/close callbacks.
 * Notifies the inpage context that streams have failed, via window.postMessage.
 * Relies on obj-multiplex and post-message-stream implementation details.
 */
function notifyInpageOfStreamFailure() {
  window.postMessage(
    {
      target: INPAGE, // the post-message-stream "target"
      data: {
        // this object gets passed to obj-multiplex
        name: PROVIDER, // the obj-multiplex channel name
        data: {
          jsonrpc: '2.0',
          method: 'METAMASK_STREAM_FAILURE',
        },
      },
    },
    window.location.origin,
  );
}

/**
 * Redirects the current page to a phishing information page
 *
 * @param data
 */
function redirectToPhishingWarning(data = {}) {
  console.debug('MetaMask: Routing to Phishing Warning page.');
  const { hostname, href } = window.location;
  const { newIssueUrl } = data;
  const baseUrl = process.env.PHISHING_WARNING_PAGE_URL;

  const querystring = new URLSearchParams({ hostname, href, newIssueUrl });
  window.location.href = `${baseUrl}#${querystring}`;
}

const start = () => {
  if (
    window.location.origin === phishingPageUrl.origin &&
    window.location.pathname === phishingPageUrl.pathname
  ) {
    setupPhishingStream();
  } else if (shouldInjectProvider()) {
    if (!isManifestV3) {
      injectScript(inpageBundle);
    }
    initStreams();
  }
};

start();
