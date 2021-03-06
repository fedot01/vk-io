import fetch from 'node-fetch';
import createDebug from 'debug';

import nodeUtil from 'util';
import nodeUrl from 'url';

import Request from './request';
import { VKError, APIError, ExecuteError } from '../errors';
import { getRandomId, delay } from '../utils/helpers';
import AccountVerification from '../auth/account-verification';
import { sequential, parallel, parallelSelected } from './workers';
import {
	MINIMUM_TIME_INTERVAL_API,
	BASE_URL_API,
	API_VERSION,

	apiErrors,
	captchaTypes
} from '../utils/constants';

const { inspect } = nodeUtil;
const { URL, URLSearchParams } = nodeUrl;

const {
	CAPTCHA_REQUIRED,
	TOO_MANY_REQUESTS,
	USER_VALIDATION_REQUIRED
} = apiErrors;

const debug = createDebug('vk-io:api');

const requestHandlers = {
	sequential,
	parallel,
	parallel_selected: parallelSelected
};

/**
 * Returns request handler
 *
 * @param {string} mode
 *
 * @return {Function}
 */
const getRequestHandler = (mode = 'sequential') => {
	const handler = requestHandlers[mode];

	if (!handler) {
		throw new VKError({
			message: 'Unsuported api mode'
		});
	}

	return handler;
};

const baseUrlSymbol = Symbol('baseURLSymbol');

const groupMethods = [
	'account',
	'ads',
	'appWidgets',
	'apps',
	'audio',
	'auth',
	'board',
	'database',
	'docs',
	'fave',
	'friends',
	'gifts',
	'groups',
	'leads',
	'leadForms',
	'likes',
	'market',
	'messages',
	'newsfeed',
	'notes',
	'notifications',
	'orders',
	'pages',
	'photos',
	'places',
	'polls',
	'podcasts',
	'prettyCards',
	'search',
	'secure',
	'stats',
	'status',
	'storage',
	'stories',
	'streaming',
	'users',
	'utils',
	'video',
	'wall',
	'widgets'
];


/**
 * Working with API methods
 *
 * @public
 */
export default class API {
	/**
	 * Constructor
	 *
	 * @param {VK} vk
	 */
	constructor(vk) {
		this.vk = vk;

		this.queue = [];
		this.started = false;
		this.suspended = false;

		this[baseUrlSymbol] = BASE_URL_API;

		for (const group of groupMethods) {
			const isMessagesGroup = group === 'messages';

			/**
			 * NOTE: Optimization for other methods
			 *
			 * Instead of checking everywhere the presence of a property in an object
			 * The check is only for the messages group
			 * Since it is necessary to change the behavior of the sending method
			 */
			this[group] = new Proxy(
				isMessagesGroup
					? {
						send: (params = {}) => {
							if (!('random_id' in params)) {
								params = {
									...params,

									random_id: getRandomId()
								};
							}

							return this.enqueue('messages.send', params);
						}
					}
					: {},
				{
					get: isMessagesGroup
						? (obj, prop) => obj[prop] || (
							params => (
								this.enqueue(`${group}.${prop}`, params)
							)
						)
						: (obj, prop) => params => (
							this.enqueue(`${group}.${prop}`, params)
						)
				}
			);
		}
	}

	/**
	 * Returns custom tag
	 *
	 * @return {string}
	 */
	get [Symbol.toStringTag]() {
		return 'API';
	}

	/**
	 * Returns the current used API version
	 *
	 * @return {string}
	 */
	get API_VERSION() {
		return API_VERSION;
	}

	/**
	 * Returns base URL
	 *
	 * @return {string}
	 */
	get baseUrl() {
		return this[baseUrlSymbol];
	}

	/**
	 * Sets base URL
	 *
	 * @param {string} url
	 *
	 * @return {string}
	 */
	set baseUrl(url) {
		if (!url.endsWith('/')) {
			url += '/';
		}

		this[baseUrlSymbol] = url;

		return url;
	}

	/**
	 * Call execute method
	 *
	 * @param {Object} params
	 *
	 * @return {Promise<Object>}
	 */
	execute(params) {
		return this.enqueue('execute', params);
	}

	/**
	 * Call execute procedure
	 *
	 * @param {string} name
	 * @param {Object} params
	 *
	 * @return {Promise<Object>}
	 */
	procedure(name, params) {
		return this.enqueue(`execute.${name}`, params);
	}

	/**
	 * Call raw method
	 *
	 * @param {string} method
	 * @param {Object} params
	 *
	 * @return {Promise<Object>}
	 */
	call(method, params) {
		return this.enqueue(method, params);
	}

	/**
	 * Adds request for queue
	 *
	 * @param {Request} request
	 *
	 * @return {Promise<Object>}
	 */
	callWithRequest(request) {
		this.queue.push(request);

		this.worker();

		return request.promise;
	}

	/**
	 * Adds method to queue
	 *
	 * @param {string} method
	 * @param {Object} params
	 *
	 * @return {Promise<Object>}
	 */
	enqueue(method, params) {
		const request = new Request(method, params);

		return this.callWithRequest(request);
	}

	/**
	 * Adds an element to the beginning of the queue
	 *
	 * @param {Request} request
	 */
	requeue(request) {
		this.queue.unshift(request);

		this.worker();
	}

	/**
	 * Running queue
	 */
	worker() {
		if (this.started) {
			return;
		}

		this.started = true;

		const { apiLimit, apiMode } = this.vk.options;

		const handler = getRequestHandler(apiMode);
		const interval = Math.round(MINIMUM_TIME_INTERVAL_API / apiLimit);

		const work = () => {
			if (this.queue.length === 0 || this.suspended) {
				this.started = false;

				return;
			}

			handler.call(this, () => {
				setTimeout(work, interval);
			});
		};

		work();
	}

	/**
	 * Calls the api method
	 *
	 * @param {Request} request
	 */
	async callMethod(request) {
		const { options } = this.vk;
		const { method } = request;

		const url = new URL(method, this.baseUrl);

		const params = {
			access_token: options.token,
			v: API_VERSION,

			...request.params
		};

		if (options.lang !== null) {
			params.lang = options.lang;
		}

		debug(`http --> ${method}`);

		const startTime = Date.now();

		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				compress: false,
				agent: options.agent,
				timeout: options.apiTimeout,
				headers: {
					...options.apiHeaders,

					connection: 'keep-alive'
				},
				body: new URLSearchParams(params)
			});

			response = await response.json();
		} catch (error) {
			if (request.addAttempt() <= options.apiAttempts) {
				await delay(options.apiWait);

				debug(`Request ${method} restarted ${request.attempts} times`);

				this.requeue(request);

				return;
			}

			if ('captcha' in request) {
				request.captcha.reject(error);
			}

			request.reject(error);

			return;
		}

		const endTime = (Date.now() - startTime).toLocaleString();

		debug(`http <-- ${method} ${endTime}ms`);

		if ('error' in response) {
			this.handleError(request, new APIError(response.error));

			return;
		}

		if ('captcha' in request) {
			request.captcha.resolve();
		}

		if (method.startsWith('execute')) {
			request.resolve({
				response: response.response,
				errors: (response.execute_errors || []).map(error => (
					new ExecuteError(error)
				))
			});

			return;
		}

		request.resolve(
			'response' in response
				? response.response
				: response
		);
	}

	/**
	 * Error API handler
	 *
	 * @param {Request} request
	 * @param {Object}  error
	 */
	async handleError(request, error) {
		const { code } = error;

		if (code === TOO_MANY_REQUESTS) {
			if (this.suspended) {
				this.requeue(request);

				return;
			}

			this.suspended = true;

			await delay((MINIMUM_TIME_INTERVAL_API / this.vk.options.apiLimit) + 50);

			this.suspended = false;

			this.requeue(request);

			return;
		}

		if ('captcha' in request) {
			request.captcha.reject(error);
		}

		if (code === USER_VALIDATION_REQUIRED) {
			if (this.suspended) {
				this.requeue(request);
			}

			this.suspended = true;

			try {
				const verification = new AccountVerification(this.vk);

				const { token } = await verification.run(error.redirectUri);

				debug('Account verification passed');

				this.vk.setToken(token);

				this.suspended = false;

				this.requeue(request);
			} catch (verificationError) {
				debug('Account verification error', verificationError);

				request.reject(error);

				await delay(15e3);

				this.suspended = false;

				this.worker();
			}

			return;
		}

		const isCaptcha = code === CAPTCHA_REQUIRED;

		if ((isCaptcha && this.vk.captchaHandler === null) || !isCaptcha) {
			request.reject(error);

			return;
		}

		const { captchaSid } = error;

		const payload = {
			type: captchaTypes.API,
			src: error.captchaImg,
			sid: captchaSid,
			request
		};

		this.vk.captchaHandler(payload, key => (
			new Promise((resolve, reject) => {
				if (key instanceof Error) {
					request.reject(key);
					reject(key);

					return;
				}

				request.params.captcha_sid = captchaSid;
				request.params.captcha_key = key;

				request.captcha = { resolve, reject };

				this.requeue(request);
			})
		));
	}

	/**
	 * Custom inspect object
	 *
	 * @param {?number} depth
	 * @param {Object}  options
	 *
	 * @return {string}
	 */
	[inspect.custom](depth, options) {
		const { name } = this.constructor;
		const { started, queue } = this;

		const payload = { started, queue };

		return `${options.stylize(name, 'special')} ${inspect(payload, options)}`;
	}
}
