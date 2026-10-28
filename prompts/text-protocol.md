This model can't call tools directly, so call them by writing lines of the form `maquette call <tool> --flag value`, each on its own line. Required arguments can go without their flag, in the order listed; objects take JSON. Maquette runs each line, after asking the person, and sends you the results. When you don't need any more calls, answer in plain words with no `maquette call` lines.

The tools, one per line:
{{tools}}
