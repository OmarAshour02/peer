const notes = [];
let nextId = 1;

export function listNotes() {
  return notes;
}

export function createNote(text) {
  const note = { id: nextId++, text: text.trim(), createdAt: new Date().toISOString() };
  notes.push(note);
  return note;
}
