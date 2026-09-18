import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Bold, Italic, Underline, List, ListOrdered, Quote, ImagePlus, Undo2, Redo2, Minus } from 'lucide-react';
import type { AddedImage, DiaryEntry, RichDocument } from '../shared/types';

export function DiaryEditor({ entry, disabled, onChange, onError, onAddImage }: {
  entry: DiaryEntry;
  disabled: boolean;
  onChange: (document: RichDocument) => void;
  onError: (error: unknown) => void;
  onAddImage: (insert: (image: AddedImage) => void) => void;
}) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      TextStyle, Color, FontSize,
      Image.configure({ allowBase64: false }),
    ],
    content: entry.document,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'diary-prose', 'aria-label': 'Diary entry', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
      handlePaste: (_view, event) => {
        if (event.clipboardData?.files.length) {
          onError(new Error('Use Add image to choose a file. Images must be encrypted before entering your diary.'));
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        if (event.dataTransfer?.files.length) {
          onError(new Error('Use Add image to choose a file instead of dragging it into the diary.'));
          return true;
        }
        return false;
      },
      transformPastedHTML: (html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('img,iframe,script,style,video,audio,object,embed,svg').forEach((node) => node.remove());
        doc.querySelectorAll('[style]').forEach((node) => node.removeAttribute('style'));
        return doc.body.innerHTML;
      },
    },
    onUpdate: ({ editor: current }) => changeRef.current(current.getJSON() as RichDocument),
  });
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold'), italic: current?.isActive('italic'), underline: current?.isActive('underline'),
      bullet: current?.isActive('bulletList'), ordered: current?.isActive('orderedList'), quote: current?.isActive('blockquote'),
      size: String(current?.getAttributes('textStyle').fontSize ?? '18px'),
      color: String(current?.getAttributes('textStyle').color ?? 'var(--cp-text)'),
    }),
  });

  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (!editor) return;
    const reportImageError = (event: Event) => {
      if (event.target instanceof HTMLImageElement) {
        onError(new Error('An encrypted image could not be opened. Check that all assets have synced and that the diary is unlocked.'));
      }
    };
    const element = editor.view.dom;
    element.addEventListener('error', reportImageError, true);
    return () => element.removeEventListener('error', reportImageError, true);
  }, [editor, onError]);
  if (!editor) return <div className="editor-loading">Opening your page...</div>;

  return <div className="editor-area">
    <div className="editor-toolbar" role="toolbar" aria-label="Text formatting">
      <div className="tool-group">
        <button className={active?.bold ? 'tool active' : 'tool'} aria-label="Bold" aria-pressed={active?.bold} title="Bold (Ctrl+B)" disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></button>
        <button className={active?.italic ? 'tool active' : 'tool'} aria-label="Italic" aria-pressed={active?.italic} title="Italic (Ctrl+I)" disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></button>
        <button className={active?.underline ? 'tool active' : 'tool'} aria-label="Underline" aria-pressed={active?.underline} title="Underline (Ctrl+U)" disabled={disabled} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={16} /></button>
      </div>
      <span className="toolbar-divider" />
      <select aria-label="Font size" className="font-select" value={active?.size} disabled={disabled} onChange={(event) => editor.chain().focus().setFontSize(event.target.value).run()}>
        <option value="16px">Small</option><option value="18px">Normal</option><option value="22px">Large</option><option value="28px">Heading</option>
      </select>
      <select aria-label="Text color" className="color-select" value={active?.color} disabled={disabled} onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}>
        <option value="var(--cp-text)">Ink</option><option value="var(--cp-text-muted)">Pencil</option><option value="var(--cp-accent)">Rose</option><option value="var(--cp-link)">Blue</option>
      </select>
      <span className="toolbar-divider" />
      <div className="tool-group">
        <button className={active?.bullet ? 'tool active' : 'tool'} aria-label="Bullet list" title="Bullet list" disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={17} /></button>
        <button className={active?.ordered ? 'tool active' : 'tool'} aria-label="Numbered list" title="Numbered list" disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={17} /></button>
        <button className={active?.quote ? 'tool active' : 'tool'} aria-label="Quote" title="Quote" disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={16} /></button>
        <button className="tool" aria-label="Divider" title="Divider" disabled={disabled} onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={16} /></button>
      </div>
      <span className="toolbar-divider" />
      <button className="image-button" disabled={disabled} onClick={() => onAddImage((image) => {
        editor.chain().focus().setImage({ src: `diary-asset://vault/${image.id}`, alt: 'Diary image' }).run();
      })}><ImagePlus size={16} /><span>Add image</span></button>
      <div className="toolbar-end"><button className="tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={disabled} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></button>
        <button className="tool" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={disabled} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></button></div>
    </div>
    <div className={`writing-surface ${editor.isEmpty ? 'is-empty' : ''}`}>
      <EditorContent editor={editor} />
      {editor.isEmpty && <span className="writing-placeholder" aria-hidden="true">What would you like to remember about today?</span>}
    </div>
  </div>;
}
