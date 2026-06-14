import type { CommandSpec } from '../types.js';
import { startCommand, stopCommand, resetCommand } from './lifecycle.js';
import { modeCommand, addmodeCommand, deletemodeCommand } from './modes.js';
import { introduceCommand, factCommand, factsCommand, clearfactsCommand } from './facts.js';
import { conversationtrackerCommand, autofactCommand, autoengageCommand } from './toggles.js';
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
  factsCommand,
  clearfactsCommand,
  conversationtrackerCommand,
  autofactCommand,
  autoengageCommand,
  banCommand,
  unbanCommand,
  usageCommand,
  languageCommand,
  termsCommand,
  helpCommand,
];
