# Get an API key

The coach runs on a key from Anthropic. This page shows you how to get one and add it to Apex. It takes about ten minutes. Do it on a computer if you can.

## What a key is

A key is a long code. It lets Apex use Claude, Anthropic's AI, on your account.

Anthropic bills you, not Apex. You pay only for what the coach uses. For most people that is a few cents a day.

Anthropic calls this code an "API key". That is the name you will see on their site.

## 1. Make an Anthropic account

Go to [console.anthropic.com](https://console.anthropic.com/) and sign up. You can use the same email you use for anything else.

<!-- EXTERNAL: https://console.anthropic.com/ — sign-up screen, signed out, email and Google sign-in visible; 375 wide; redact nothing -->
![The sign-up screen at console.anthropic.com](/help/get-api-key/01-console-sign-up.phone.png)

## 2. Add some credit

The coach cannot run on an empty account. Open **Billing** and buy credits. You can start with as little as $5.

<!-- EXTERNAL: https://console.anthropic.com/settings/billing — Billing page, "Buy credits" visible, balance shown; 1280 wide; redact org name, email, card details and balance -->
![The Billing page, where you buy credits](/help/get-api-key/02-billing-credits.desktop.png)

## 3. Go to the keys page

Go to **Settings**, then **API keys**. Tap **Create Key**.

<!-- EXTERNAL: https://console.anthropic.com/settings/keys — API keys page, empty list, "Create Key" visible; 1280 wide; redact org name and email -->
![The API keys page with the Create Key button](/help/get-api-key/03-api-keys-empty.desktop.png)

## 4. Name the key and pick a workspace

Give the key a name, like "Apex".

This next part matters most. Set **Workspace** to a named workspace, like "Default". Do not leave it on "same as personal account". Apex cannot use a key that is not tied to one workspace.

If you are asked how long the key should last, pick the longest time. The coach stops working the day the key runs out.

<!-- EXTERNAL: https://console.anthropic.com/settings/keys — "Create Key" dialog open, name "Apex" typed, Workspace set to a named workspace (e.g. Default), not "same as personal account"; 1280 wide; redact org name and email -->
![The Create Key box, with Workspace set to a named workspace](/help/get-api-key/04-create-key-workspace.desktop.png)

## 5. Copy the key

Anthropic shows the whole key only once. Copy it now. It starts with `sk-ant-`.

Keep it private, like a password. Anyone with it can spend your credit.

<!-- EXTERNAL: https://console.anthropic.com/settings/keys — one-time key reveal right after Create Key, copy button visible; 1280 wide; redact everything after "sk-ant-", org name and email -->
![The new key, shown once, with a button to copy it](/help/get-api-key/05-key-reveal.desktop.png)

## 6. Paste it into Apex

In Apex, tap your picture at the top left. That opens **Profile**. Find **Anthropic key**. It opens by itself when no key is saved.

Paste your key into the box. Tap **Save key**. Apex checks the key with Anthropic before it saves it.

![Profile, with the key pasted and the Save key button](/help/get-api-key/06-paste-key.desktop.png)

![The same place on a phone](/help/get-api-key/06-paste-key.phone.png)

## 7. You are done

Apex shows only the end of your key. **Replace** swaps in a new key. **Remove** deletes it from Apex.

Now open the coach and ask it something.

![The saved key, with Replace and Remove next to it](/help/get-api-key/07-key-saved.desktop.png)

![The saved key on a phone](/help/get-api-key/07-key-saved.phone.png)

## Already pay for Claude?

A Claude Pro or Max plan does not include a key. Anthropic does not let apps like Apex use your plan.

The coach needs its own key from console.anthropic.com. You can sign up there with the same email. That key is paid for separately, by how much you use. You can add as little as $5 to start.

If Anthropic ever lets apps use a plan, we will add it here.

## What it costs

You pay Anthropic for each message the coach reads and writes. A normal day of questions costs a few cents. A long chat costs more than a short one.

Pick which Claude model answers from the menu next to **Coach**. It sits at the top of the coach. Each choice shows two prices. One is for what the coach reads, one for what it writes. Smaller numbers cost less. **Haiku 4.5**, at the bottom, is the cheapest. Your pick also writes your workout summaries.

You can see what you have spent on the **Billing** page at console.anthropic.com.

## If something goes wrong

**"That key is not tied to a single workspace"** shows under the box. The key was made with Workspace left on "same as personal account". Go back to step 4 and make a new key with a named workspace. Paste the new one.

**"That Anthropic API key was rejected by Anthropic"** means the key is wrong. It may be mistyped, deleted or out of date. Copy it again, or make a new one.

**The coach answers "Sorry, I ran into an error. Please try again."** every time. Two things cause this:

- Your credit ran out. Open **Billing** at console.anthropic.com and buy more.
- Your key ran out, or was deleted. Make a new key (steps 3 to 5). In Profile, tap **Replace** and paste it.

**The coach says "To use the coach, add a key from Anthropic"**. No key is saved. Follow step 6.

**The coach says it is "taking a breather"**. You sent a lot of messages in a short time. This is Apex's limit, not your credit. Wait a few minutes and try again.
