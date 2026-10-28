#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../config';
import { buildStacks } from '../lib/build-stacks';

const app = new App();
const envName = app.node.tryGetContext('env') ?? 'dev';
const cfg = loadConfig(envName);

buildStacks(app, cfg);

for (const [key, value] of Object.entries(cfg.tags)) {
  Tags.of(app).add(key, value);
}
