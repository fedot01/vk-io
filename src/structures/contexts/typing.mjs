import Context from './context';

import { CHAT_PEER } from '../../utils/constants';

export default class TypingContext extends Context {
	/**
	 * Constructor
	 *
	 * @param {VK}     vk
	 * @param {Array}  payload
	 * @param {Object} options
	 */
	constructor(vk, [eventId, userId, extra]) {
		super(vk);

		const isChat = eventId === 62;

		this.payload = {
			user_id: userId,
			chat_id: isChat
				? extra
				: null,
			peer_id: isChat
				? extra + CHAT_PEER
				: userId

		};

		this.type = 'typing';
		this.subTypes = [
			eventId === 61
				? 'typing_user'
				: 'typing_chat'
		];
	}

	/**
	 * Checks that the message is typed in the dm
	 *
	 * @return {boolean}
	 */
	get isUser() {
		return this.subTypes.includes('typing_user');
	}

	/**
	 * Checks that the message is typed in the chat
	 *
	 * @return {boolean}
	 */
	get isChat() {
		return this.subTypes.includes('typing_chat');
	}

	/**
	 * Returns the identifier peer
	 *
	 * @return {number}
	 */
	get peerId() {
		return this.payload.peer_id;
	}

	/**
	 * Returns the identifier user
	 *
	 * @return {number}
	 */
	get userId() {
		return this.payload.user_id;
	}

	/**
	 * Returns the identifier chat
	 *
	 * @return {?number}
	 */
	get chatId() {
		return this.payload.chat_id;
	}
}
