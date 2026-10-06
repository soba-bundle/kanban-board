import {useState} from "react";
import {Card} from "@astryxdesign/core/Card";
import {Button} from "@astryxdesign/core/Button";
import {IconButton} from "@astryxdesign/core/IconButton";
import {Icon} from "@astryxdesign/core/Icon";
import {ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatToolCalls} from "@astryxdesign/core/Chat";
import {Layout, LayoutContent, LayoutHeader, LayoutPanel, StackItem, HStack, VStack} from "@astryxdesign/core/Layout";
import {MetadataList, MetadataListItem} from "@astryxdesign/core/MetadataList";
import {StatusDot} from "@astryxdesign/core/StatusDot";
import {Text, Heading} from "@astryxdesign/core/Text";
import {Token} from "@astryxdesign/core/Token";
import {useMediaQuery} from "@astryxdesign/core/hooks";

function TicketInspector() {
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <Layout
      height="fill"
      className="ticket-inspector"
      header={
        <LayoutHeader padding={4} hasDivider>
          <VStack gap={3}>
            <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
              <HStack gap={1} vAlign="center" className="ticket-title-group">
                <Heading className="ticket-title-text" level={3} maxLines={2}>Write a simple readme</Heading>
                <IconButton
                  className="ticket-details-toggle"
                  size="sm"
                  variant="ghost"
                  label={detailsOpen ? "Hide ticket details" : "Show ticket details"}
                  tooltip={detailsOpen ? "Hide details" : "Show details"}
                  icon={<Icon icon="chevronDown" />}
                  aria-expanded={detailsOpen}
                  aria-controls="preview-ticket-details"
                  onClick={() => setDetailsOpen((open) => !open)}
                />
              </HStack>
              <Token
                label="REVIEW"
                color="orange"
                size="sm"
                icon={<StatusDot variant="warning" label="Needs review" />}
              />
            </HStack>
            <VStack
              id="preview-ticket-details"
              className="ticket-details-content"
              hidden={!detailsOpen}
              style={{paddingBlock: "var(--spacing-2)", paddingInline: "var(--spacing-3)"}}
            >
              <MetadataList label={{position: "top"}}>
                <MetadataListItem label="Description">
                  <Text type="body">Write a concise README that explains the project and links to the current plan.</Text>
                </MetadataListItem>
                <MetadataListItem label="Workflow">
                  <Text type="body">Review · work complete</Text>
                </MetadataListItem>
                <MetadataListItem label="Latest run">
                  <Text type="body">Work · response streaming</Text>
                </MetadataListItem>
              </MetadataList>
            </VStack>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <ChatLayout
            density="compact"
            composer={
              <VStack gap={2}>
                <Text type="supporting" color="secondary">
                  {isStreaming ? "Agent is working · Stop is available" : "Stopped · send guidance to continue"}
                </Text>
                <ChatComposer
                  className="ticket-chat-composer"
                  density="compact"
                  value={draft}
                  onChange={setDraft}
                  onSubmit={(value) => { if (value.trim()) { setDraft(""); setIsStreaming(true); } }}
                  input={<textarea
                    className="ticket-composer-input"
                    aria-label="Message input"
                    rows={1}
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        if (draft.trim()) { setDraft(""); setIsStreaming(true); }
                      }
                    }}
                    placeholder="What should the agent do?"
                  />}
                  sendButton={<IconButton size="md" variant="primary" icon={<Icon icon="arrowUp" />} label="Send guidance"
                    isDisabled={!draft.trim()} onClick={() => { setDraft(""); setIsStreaming(true); }} />}
                  sendActions={isStreaming && <Button size="md" variant="secondary" label="Stop" onClick={() => setIsStreaming(false)} />}
                />
              </VStack>
            }
          >
            <ChatMessageList density="compact" align="top" isStreaming={isStreaming}>
              <ChatMessage sender="user">
                <ChatMessageBubble>
                  <Text type="body">Can you compact the README?</Text>
                </ChatMessageBubble>
              </ChatMessage>
              <ChatMessage sender="assistant">
                <ChatMessageBubble variant="ghost">
                  <VStack gap={2}>
                    <Text type="body">I’ll inspect the README and package context before editing.</Text>
                    <ChatToolCalls
                      defaultIsExpanded
                      calls={[
                        {key: "read-readme", name: "read", status: "complete", target: "README.md", duration: "0.3s", stats: "22 lines read"},
                        {key: "read-package", name: "read", status: "complete", target: "package.json", duration: "0.1s", stats: "55 lines read"},
                        {key: "check-guidance", name: "read", status: "complete", target: "APPEND_SYSTEM.md", duration: "0.1s", stats: "Markdown guidance"},
                      ]}
                    />
                  </VStack>
                </ChatMessageBubble>
              </ChatMessage>
              <ChatMessage sender="assistant">
                <ChatMessageBubble variant="ghost">
                  <VStack gap={2}>
                    <Text type="body">The README repeated the project overview. I’ve shortened it while preserving the setup and workflow links.</Text>
                    <HStack gap={2} vAlign="center">
                      <StatusDot variant={isStreaming ? "accent" : "neutral"} label={isStreaming ? "Streaming" : "Stopped"} isPulsing={isStreaming} />
                      <Text type="supporting" color="secondary">{isStreaming ? "Final response streaming" : "Generation stopped"}</Text>
                    </HStack>
                  </VStack>
                </ChatMessageBubble>
              </ChatMessage>
            </ChatMessageList>
          </ChatLayout>
        </LayoutContent>
      }
    />
  );
}

function BoardPreview() {
  return (
    <LayoutContent padding={6}>
      <VStack gap={5}>
        <VStack gap={1}>
          <Heading level={2}>Tickets</Heading>
          <Text type="supporting" color="secondary">The board remains visible while the ticket is open.</Text>
        </VStack>
        <HStack gap={4} vAlign="start">
          <StackItem size="fill">
            <VStack gap={3}>
              <Heading level={4}>In progress</Heading>
              <Card padding={3} variant="muted">
                <VStack gap={1}>
                  <Text weight="semibold">Update onboarding flow</Text>
                  <Text type="supporting" color="secondary">Investigating activation drop-off</Text>
                </VStack>
              </Card>
            </VStack>
          </StackItem>
          <StackItem size="fill">
            <VStack gap={3}>
              <Heading level={4}>Review</Heading>
              <Card padding={3}>
                <VStack gap={1}>
                  <Text weight="semibold">Write a simple readme</Text>
                  <Text type="supporting" color="secondary">README.md · updated just now</Text>
                </VStack>
              </Card>
            </VStack>
          </StackItem>
        </HStack>
      </VStack>
    </LayoutContent>
  );
}

export default function LiveTicketPreview() {
  const isNarrow = useMediaQuery("(max-width: 1024px)");

  return (
    <Layout
      height="fill"
      contentWidth={1260}
      header={isNarrow ? undefined : (
        <LayoutHeader padding={4} hasDivider>
          <HStack gap={2} vAlign="center">
            <Heading level={3}>Kanban board</Heading>
            <Text type="supporting" color="secondary">Ticket inspector design preview</Text>
          </HStack>
        </LayoutHeader>
      )}
      content={isNarrow ? <LayoutContent padding={0}><TicketInspector /></LayoutContent> : <BoardPreview />}
      end={isNarrow ? undefined : (
        <LayoutPanel width={640} padding={0} role="complementary" label="Ticket details" hasDivider>
          <TicketInspector />
        </LayoutPanel>
      )}
    />
  );
}
