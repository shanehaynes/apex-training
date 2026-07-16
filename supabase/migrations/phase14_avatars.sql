-- Phase 14: add four marine avatars (orca, seal, otter, octopus), 24 total.
--
-- Keys must stay in sync with src/lib/profile/avatars.ts and the
-- allowlist in api/profile.ts.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_avatar_key_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_avatar_key_check CHECK (avatar_key IN (
    'goat','ibex','snow-leopard','eagle','wolf',
    'bighorn','marmot','raven','lynx','fox',
    'bear','owl','falcon','pika','elk',
    'wolverine','cougar','chamois','yak','hare',
    'orca','seal','otter','octopus'
  ));

-- Signup trigger: pick the random starter avatar from the full set.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_key)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    (ARRAY[
      'goat','ibex','snow-leopard','eagle','wolf',
      'bighorn','marmot','raven','lynx','fox',
      'bear','owl','falcon','pika','elk',
      'wolverine','cougar','chamois','yak','hare',
      'orca','seal','otter','octopus'
    ])[floor(random()*24)::int + 1]
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;
