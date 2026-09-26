import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import clsx from 'clsx';
import { useMessenger } from './lib/useMessenger';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { ChatWorkspace } from './components/ChatWorkspace';
import { NewChatDialog } from './components/NewChatDialog';
import { ConnectionDialog } from './components/ConnectionDialog';
import { TelegramMark } from './components/ui';

export default function App() {
  const messenger = useMessenger();
  const [query, setQuery] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [contactName, setContactName] = useState('');
  const [mobileChat, setMobileChat] = useState(false);
  useEffect(() => {
    if (messenger.mode === 'login') {
      setMobileChat(false);
      setNewChatOpen(false);
      setSettingsOpen(false);
    }
  }, [messenger.mode]);
  async function createChat(event: FormEvent) {
    event.preventDefault();
    const chat = await messenger.createChat(recipient.trim(), contactName.trim() || undefined);
    if (chat) {
      setNewChatOpen(false);
      setRecipient('');
      setContactName('');
      setMobileChat(true);
    }
  }
  if (messenger.isRestoring)
    return (
      <main className="restoring">
        <TelegramMark large />
        <LoaderCircle className="spin" size={23} />
        <p>Открываем ваши диалоги…</p>
      </main>
    );
  if (messenger.mode === 'login') return <LoginScreen messenger={messenger} />;
  return (
    <main className={clsx('messenger', mobileChat && 'show-mobile-chat')}>
      <Sidebar
        messenger={messenger}
        query={query}
        onQueryChange={setQuery}
        onSettings={() => setSettingsOpen(true)}
        onNewChat={() => setNewChatOpen(true)}
        onOpenChat={() => setMobileChat(true)}
      />
      <ChatWorkspace
        messenger={messenger}
        newChatOpen={newChatOpen}
        onBack={() => setMobileChat(false)}
        onSettings={() => setSettingsOpen(true)}
        onNewChat={() => setNewChatOpen(true)}
      />
      <NewChatDialog
        messenger={messenger}
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        recipient={recipient}
        onRecipientChange={setRecipient}
        contactName={contactName}
        onContactNameChange={setContactName}
        onSubmit={createChat}
      />
      <ConnectionDialog messenger={messenger} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </main>
  );
}
