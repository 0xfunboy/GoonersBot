import type { CommandSpec } from '../types.js';
import { startCommand, stopCommand, resetCommand } from './lifecycle.js';
import { modeCommand, addmodeCommand, deletemodeCommand } from './modes.js';
import {
  introduceCommand,
  setfactCommand,
  factsCommand,
  clearfactsCommand,
  loreCommand,
  forgetCommand,
} from './facts.js';
import { brainCommand, debuglastCommand } from './debug.js';
import { voiceCommand } from './voice.js';
import { playCommand, singCommand } from './music.js';
import { translateCommand } from './translate.js';
import {
  conversationtrackerCommand,
  autoengageCommand,
  autopostCommand,
  linkmediaCommand,
} from './toggles.js';
import { newsCommand } from './news.js';
import { drawCommand, imageCommand } from './image.js';
import { videoCommand } from './video.js';
import { nsfwCommand } from './nsfw.js';
import { banCommand, unbanCommand } from './moderation.js';
import { usageCommand, languageCommand, tosCommand, helpCommand } from './misc.js';
import { approveCommand, unapproveCommand, approvedCommand } from './access.js';
import { profileCommand } from './profile.js';
import { visionCommand } from './vision.js';
import { capabilitiesCommand, learnCommand } from './capabilities.js';
import { communityCommand, socialstatusCommand } from './community.js';
import { botinfoCommand, hardwareCommand, modelsCommand, quotaCommand } from './systemInfo.js';
import { animeCommand, followCommand, followingCommand, unfollowCommand } from './anime.js';
import { adminCommand, adminsCommand, idCommand, unadminCommand } from './identity.js';
import { registerCommandCatalog } from './aliases.js';

/** All command handlers (original parity + voice/traduci extras). */
export const commandHandlers: CommandSpec[] = [
  startCommand,
  stopCommand,
  resetCommand,
  modeCommand,
  addmodeCommand,
  deletemodeCommand,
  introduceCommand,
  setfactCommand,
  factsCommand,
  clearfactsCommand,
  loreCommand,
  forgetCommand,
  conversationtrackerCommand,
  autoengageCommand,
  autopostCommand,
  linkmediaCommand,
  newsCommand,
  imageCommand,
  drawCommand,
  videoCommand,
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
  visionCommand,
  capabilitiesCommand,
  learnCommand,
  communityCommand,
  socialstatusCommand,
  hardwareCommand,
  modelsCommand,
  quotaCommand,
  botinfoCommand,
  idCommand,
  adminCommand,
  unadminCommand,
  adminsCommand,
  animeCommand,
  followCommand,
  unfollowCommand,
  followingCommand,
];

// Validate the complete command/alias surface once, then publish the same catalog to /help.
registerCommandCatalog(commandHandlers);
