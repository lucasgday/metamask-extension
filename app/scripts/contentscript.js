import pump from 'pump';
import { WindowPostMessageStream } from '@metamask/post-message-stream';
import ObjectMultiplex from 'obj-multiplex';
import browser from 'webextension-polyfill';
import PortStream from 'extension-port-stream';
import { obj as createThoughStream } from 'through2';

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
const LEGACY_CONTENT_SCRIPT = 'contentscript';
const LEGACY_INPAGE = 'inpage';
const LEGACY_PROVIDER = 'provider';
const LEGACY_PUBLIC_CONFIG = 'publicConfig';

let legacyExtMux,
  legacyExtChannel,
  legacyExtPublicConfigChannel,
  legacyPageMux,
  legacyPageMuxLegacyProviderChannel,
  legacyPagePublicConfigChannel,
  notificationTransformStream;

const WORKER_KEEP_ALIVE_MESSAGE = 'WORKER_KEEP_ALIVE_MESSAGE';

const phishingPageUrl = new URL(process.env.PHISHING_WARNING_PAGE_URL);

let phishingExtensionChannel,
  phishingExtensionMux,
  phishingExtensionPort,
  phishingExtensionStream,
  phishingPageChannel,
  phishingPageMux;

let extensionMux,
  extensionChannel,
  extensionPort,
  extensionPhishingStream,
  extensionStream,
  pageMux,
  pageChannel;

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

function setupPhishingPageStreams() {
  // the transport-specific streams for communication between inpage and background
  const pagePhishingStream = new WindowPostMessageStream({
    name: CONTENT_SCRIPT,
    target: PHISHING_WARNING_PAGE,
  });

  // create and connect channel muxers so we can handle the channels individually
  phishingPageMux = new ObjectMultiplex();
  phishingPageMux.setMaxListeners(25);

  pump(phishingPageMux, pagePhishingStream, phishingPageMux, (err) =>
    logStreamDisconnectWarning('MetaMask Inpage Multiplex', err),
  );

  phishingPageChannel = phishingPageMux.createStream(PHISHING_SAFELIST);
}

const setupPhishingExtensionStream = () => {
  phishingExtensionPort = browser.runtime.connect({
    name: CONTENT_SCRIPT,
  });
  phishingExtensionStream = new PortStream(phishingExtensionPort);

  // create and connect channel muxers so we can handle the channels individually
  phishingExtensionMux = new ObjectMultiplex();
  phishingExtensionMux.setMaxListeners(25);

  pump(
    phishingExtensionMux,
    phishingExtensionStream,
    phishingExtensionMux,
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
  phishingExtensionChannel =
    phishingExtensionMux.createStream(PHISHING_SAFELIST);
  pump(
    phishingPageChannel,
    phishingExtensionChannel,
    phishingPageChannel,
    (error) =>
      console.debug(
        `MetaMask: Muxed traffic for channel "${PHISHING_SAFELIST}" failed.`,
        error,
      ),
  );
};

/** Destroys all of the phishing extension streams */
const destroyPhishingExtensionStreams = () => {
  phishingPageChannel.removeAllListeners();

  phishingExtensionMux.removeAllListeners();
  phishingExtensionMux.destroy();

  phishingExtensionChannel.removeAllListeners();
  phishingExtensionChannel.destroy();
};

/**
 * Resets the extension stream with new streams and attaches event listeners to the extension port.
 */
const resetPhishingStreamAndListeners = () => {
  extensionPort.onDisconnect.removeListener(resetPhishingStreamAndListeners);

  /**
   * The message below will try to activate service worker.
   * In MV3, a likely reason that a stream closes is when the service worker goes in-active
   */
  browser.runtime.sendMessage({ name: WORKER_KEEP_ALIVE_MESSAGE });

  destroyPhishingExtensionStreams();
  setupPhishingExtensionStream();

  extensionPort.onDisconnect.addListener(resetPhishingStreamAndListeners);
};

const initPhishingStreams = () => {
  setupPhishingPageStreams();
  setupPhishingExtensionStream();

  extensionPort.onDisconnect.addListener(resetPhishingStreamAndListeners);
};

const setupPageStreams = () => {
  // the transport-specific streams for communication between inpage and background
  const pageStream = new WindowPostMessageStream({
    name: CONTENT_SCRIPT,
    target: INPAGE,
  });

  // create and connect channel muxers so we can handle the channels individually
  pageMux = new ObjectMultiplex();
  pageMux.setMaxListeners(25);

  pump(pageMux, pageStream, pageMux, (err) =>
    logStreamDisconnectWarning('MetaMask Inpage Multiplex', err),
  );

  pageChannel = pageMux.createStream(PROVIDER);
};

const setupExtensionStreams = () => {
  extensionPort = browser.runtime.connect({ name: CONTENT_SCRIPT });
  extensionStream = new PortStream(extensionPort);

  // create and connect channel muxers so we can handle the channels individually
  extensionMux = new ObjectMultiplex();
  extensionMux.setMaxListeners(25);
  extensionMux.ignoreStream(LEGACY_PUBLIC_CONFIG); // TODO:LegacyProvider: Delete

  pump(extensionMux, extensionStream, extensionMux, (err) => {
    logStreamDisconnectWarning('MetaMask Background Multiplex', err);
    notifyInpageOfStreamFailure();
  });

  // forward communication across inpage-background for these channels only
  extensionChannel = extensionMux.createStream(PROVIDER);
  pump(pageChannel, extensionChannel, pageChannel, (error) =>
    console.debug(
      `MetaMask: Muxed traffic for channel "${PROVIDER}" failed.`,
      error,
    ),
  );

  // connect "phishing" channel to warning system
  extensionPhishingStream = extensionMux.createStream('phishing');
  extensionPhishingStream.once('data', redirectToPhishingWarning);
};

/** Destroys all of the extension streams */
const destroyExtensionStreams = () => {
  pageChannel.removeAllListeners();

  extensionMux.removeAllListeners();
  extensionMux.destroy();

  extensionChannel.removeAllListeners();
  extensionChannel.destroy();
};

/**
 * Sets up two-way communication streams between the
 * browser extension and local per-page browser context.
 *
 * TODO:LegacyProvider: Delete
 */
const setupLegacyPageStreams = () => {
  const legacyPageStream = new WindowPostMessageStream({
    name: LEGACY_CONTENT_SCRIPT,
    target: LEGACY_INPAGE,
  });

  legacyPageMux = new ObjectMultiplex();
  legacyPageMux.setMaxListeners(25);

  pump(legacyPageMux, legacyPageStream, legacyPageMux, (err) =>
    logStreamDisconnectWarning('MetaMask Legacy Inpage Multiplex', err),
  );

  legacyPageMuxLegacyProviderChannel =
    legacyPageMux.createStream(LEGACY_PROVIDER);
  legacyPagePublicConfigChannel =
    legacyPageMux.createStream(LEGACY_PUBLIC_CONFIG);
};

const setupLegacyExtensionStreams = () => {
  legacyExtMux = new ObjectMultiplex();
  legacyExtMux.setMaxListeners(25);

  notificationTransformStream = getNotificationTransformStream();
  pump(
    legacyExtMux,
    extensionStream,
    notificationTransformStream,
    legacyExtMux,
    (err) => {
      logStreamDisconnectWarning('MetaMask Background Legacy Multiplex', err);
      notifyInpageOfStreamFailure();
    },
  );

  legacyExtChannel = legacyExtMux.createStream(PROVIDER);
  pump(
    legacyPageMuxLegacyProviderChannel,
    legacyExtChannel,
    legacyPageMuxLegacyProviderChannel,
    (error) =>
      console.debug(
        `MetaMask: Muxed traffic between channels "${LEGACY_PROVIDER}" and "${PROVIDER}" failed.`,
        error,
      ),
  );

  legacyExtPublicConfigChannel =
    legacyExtMux.createStream(LEGACY_PUBLIC_CONFIG);
  pump(
    legacyPagePublicConfigChannel,
    legacyExtPublicConfigChannel,
    legacyPagePublicConfigChannel,
    (error) =>
      console.debug(
        `MetaMask: Muxed traffic for channel "${LEGACY_PUBLIC_CONFIG}" failed.`,
        error,
      ),
  );
};

/** Destroys all of the legacy extension streams */
const destroyLegacyExtensionStreams = () => {
  legacyPageMuxLegacyProviderChannel.removeAllListeners();
  legacyPagePublicConfigChannel.removeAllListeners();

  legacyExtMux.removeAllListeners();
  legacyExtMux.destroy();

  legacyExtChannel.removeAllListeners();
  legacyExtChannel.destroy();

  legacyExtPublicConfigChannel.removeAllListeners();
  legacyExtPublicConfigChannel.destroy();
};

/**
 * Resets the extension stream with new streams and attaches event listeners to the extension port.
 */
const resetStreamAndListeners = () => {
  extensionPort.onDisconnect.removeListener(resetStreamAndListeners);

  /**
   * The message below will try to activate service worker.
   * In MV3, a likely reason that a stream closes is when the service worker goes in-active
   */
  browser.runtime.sendMessage({ name: WORKER_KEEP_ALIVE_MESSAGE });

  destroyExtensionStreams();
  setupExtensionStreams();

  destroyLegacyExtensionStreams();
  setupLegacyExtensionStreams();

  extensionPort.onDisconnect.addListener(resetStreamAndListeners);
};

/**
 * Sets up two-way communication streams between the
 * browser extension and local per-page browser context.
 */
const initStreams = () => {
  setupPageStreams();
  setupExtensionStreams();

  // TODO:LegacyProvider: Delete
  setupLegacyPageStreams();
  setupLegacyExtensionStreams();

  extensionPort.onDisconnect.addListener(resetStreamAndListeners);
};

// TODO:LegacyProvider: Delete
function getNotificationTransformStream() {
  return createThoughStream((chunk, _, cb) => {
    if (chunk?.name === PROVIDER) {
      if (chunk.data?.method === 'metamask_accountsChanged') {
        chunk.data.method = 'wallet_accountsChanged';
        chunk.data.result = chunk.data.params;
        delete chunk.data.params;
      }
    }
    cb(null, chunk);
  });
}

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
  console.log('Notifying Inpage of Stream Failure');

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
    initPhishingStreams();
  } else if (shouldInjectProvider()) {
    if (!isManifestV3) {
      injectScript(inpageBundle);
    }
    initStreams();
  }
};

start();
