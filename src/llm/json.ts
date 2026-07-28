export const extractFirstJsonObject = (text: string): string => {
  const input = text.trim();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (start === -1) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (character === '\\') {
        escaping = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  throw new Error('Model response did not contain a complete JSON object');
};
