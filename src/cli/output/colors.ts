/**
 * Terminal color utilities for CLI output
 */

export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/**
 * Colors text red
 */
export function red(text: string): string {
  return `${colors.red}${text}${colors.reset}`;
}

/**
 * Colors text green
 */
export function green(text: string): string {
  return `${colors.green}${text}${colors.reset}`;
}

/**
 * Colors text yellow
 */
export function yellow(text: string): string {
  return `${colors.yellow}${text}${colors.reset}`;
}

/**
 * Colors text blue
 */
export function blue(text: string): string {
  return `${colors.blue}${text}${colors.reset}`;
}

/**
 * Colors text cyan
 */
export function cyan(text: string): string {
  return `${colors.cyan}${text}${colors.reset}`;
}

/**
 * Makes text bright
 */
export function bright(text: string): string {
  return `${colors.bright}${text}${colors.reset}`;
}

