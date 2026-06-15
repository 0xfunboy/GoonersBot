import type { CommandSpec } from '../types.js';
import { startCommand, stopCommand, resetCommand } from './lifecycle.js';
import { modeCommand, addmodeCommand, deletemodeCommand } from './modes.js';
import {
  introduceCommand,
  factCommand,
  setfactCommand,
  factsCommand,
  clearfactsCommand,
  loreCommand,
  forgetCommand,
} from './facts.js';
import { brainCommand, debuglastCommand } from './debug.js';
import { conversationtrackerCommand, autofactCommand, autoengageCommand } from './toggles.js';
import { nsfwCommand } from './nsfw.js';
import { banCommand, unbanCommand } from './moderation.js';
import { usageCommand, languageCommand, termsCommand, helpCommand } from './misc.js';

/** All command handlers (19, full parity with the original incl. undocumented /facts). */
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
  loreCommand,
  forgetCommand,
  conversationtrackerCommand,
  autofactCommand,
  autoengageCommand,
  nsfwCommand,
  banCommand,
  unbanCommand,
  usageCommand,
  languageCommand,
  termsCommand,
  brainCommand,
  debuglastCommand,
  helpCommand,
];
