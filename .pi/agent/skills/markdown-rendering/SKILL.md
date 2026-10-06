---
name: markdown-rendering
description: Use when rendering Markdown documents directly in conversation, especially when they contain fenced code examples or the user asks to see literal Markdown file or source.
---

# Markdown rendering

- If the user wants a document rendered in chat, output its Markdown directly. Do not fence the entire document by default; its own code blocks will render normally.
- Only wrap the entire document when the user explicitly wants to see the literal Markdown file or source.
- When fencing literal source that contains triple-backtick blocks, use four backticks for the outer fence. In general, make the outer fence longer than every fence inside it, and close it with the same delimiter length.
- The custom renderer uses four backticks in order to create the outer fence, so ensure that when fencing triple-backtick blocks, the outer fence is always four backticks.
- Preserve standard Markdown backtick or tilde fences. Do not replace them with colon/container syntax such as `::::code-block{bash}`.

Example: to show this Markdown source literally, use four backticks outside the three-backtick `sh` block:

````markdown
# Setup

```sh
npm install
npm start
```
````
