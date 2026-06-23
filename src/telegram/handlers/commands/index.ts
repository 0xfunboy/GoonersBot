import type { CommandSpec } from '../types.js';
import { startCommand, stopCommand, resetCommand } from './lifecycle.js';
import { modeCommand, addmodeCommand, deletemodeCommand } from './modes.js';
import {
  introduceCommand,
  factCommand,
  setfactCommand,
  factsCommand,
  clearfactsCommand,
  forgetCommand,
} from './facts.js';
import { brainCommand, debuglastCommand } from './debug.js';
import { voiceCommand } from './voice.js';
import { playCommand, singCommand } from './music.js';
import { translateCommand } from './translate.js';
import {
  conversationtrackerCommand,
  autofactCommand,
  autoengageCommand,
  autopostCommand,
  linkmediaCommand,
} from './toggles.js';
import { newsCommand } from './news.js';
import { drawCommand, imageCommand } from './image.js';
import { nsfwCommand } from './nsfw.js';
import { banCommand, unbanCommand } from './moderation.js';
import { usageCommand, languageCommand, tosCommand, helpCommand } from './misc.js';
import { approveCommand, unapproveCommand, approvedCommand } from './access.js';
import { profileCommand } from './profile.js';

/** All command handlers (original parity + voice/traduci extras). */
export const commandHandlers: CommandSpec[] = [
  startCommand,
  stopCommand,
  resetCommand,
  modeCommand,
  addmodeCommand,
  deletemodeCommand,
  introduceCommand,
  factCommand,
  setfactCommand,
  factsCommand,
  clearfactsCommand,
  forgetCommand,
  conversationtrackerCommand,
  autofactCommand,
  autoengageCommand,
  autopostCommand,
  linkmediaCommand,
  newsCommand,
  imageCommand,
  drawCommand,
  nsfwCommand,
  banCommand,
  unbanCommand,
  usageCommand,
  languageCommand,
  tosCommand,
  voiceCommand,
  playCommand,
  singCommand,
  translateCommand,
  brainCommand,
  debuglastCommand,
  helpCommand,
  approveCommand,
  unapproveCommand,
  approvedCommand,
  profileCommand,
];
