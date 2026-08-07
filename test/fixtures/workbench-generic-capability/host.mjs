export const tools = {
  'fixture:generate': (context) => context.capabilities.invoke(
    'media.video.generate',
    1,
    { prompt: 'fixture' },
  ),
}
