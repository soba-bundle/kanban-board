export function displayTaskTitle(title: string): string {
  const firstCharacter = Array.from(title)[0];
  return firstCharacter ? `${firstCharacter.toUpperCase()}${title.slice(firstCharacter.length)}` : title;
}
