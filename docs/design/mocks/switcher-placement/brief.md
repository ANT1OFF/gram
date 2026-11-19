# Workspace switcher placement

## Problem

An embedding app's workspace switcher (`shell.workspaceSwitcher`) sits at the head of the open
sidebar, under New. Magnus finds it odd there and wants it at the sidebar's foot or in Settings.

## Who and where

People in an app that mounts Gram and passes a switcher. Gram draws the slot; the app draws the
switcher. Gram on its own has no embed switcher and is unchanged.

## Must show

A at the foot beside the account and Settings; B in Settings only with a compact current-workspace
label in the title bar. Each with the side, top-dock and auto-hide navigation, and on a phone, in
light and dark.

## Out of scope

The switcher's own look and menu, which the embedding app draws; Gram's own workspace switcher in
the title bar.

## Open questions

Which direction becomes the default for the embedding app. Either ships as a general option, with
today's head placement kept as Gram's default.
