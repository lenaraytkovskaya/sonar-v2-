import { z } from 'zod';
export const campaignProgressPollSchema = z.number().int().min(5000).max(10000);
